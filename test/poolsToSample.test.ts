import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Which pools get the sampling budget.
 *
 * The series is the one thing here a competitor cannot catch up on, so what
 * fills it matters more than how fast. Ranked on swaps alone the sampler spent
 * half its budget on pools whose drift can never be computed — measured in
 * production on 2026-09-05, 1,368 of 1,372 v4 rows carried no deviation,
 * because the busiest v4 stock pools are paired against memecoins. Those rows
 * cost the same to collect and store as any other and can never answer the
 * question the series exists for.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'sample-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const { poolsToSample } = await import('../src/history/snapshot.js');
const { TOKENS } = await import('../config/addresses.js');

const NVDA_TOKEN = '0x1111111111111111111111111111111111111111';
const AAPL_TOKEN = '0x2222222222222222222222222222222222222222';
/** "Greatest Meme Ever" — a real token on this chain, ticker GME, not a stock. */
const MEME = '0xef67e3064bef1a27e81925ec7132f23e533bd5f6';

function addFeed(symbol: string, kind = 'stock') {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO feeds
         (symbol, proxy_address, decimals, heartbeat, threshold, name, kind, synced_at)
       VALUES (?, ?, 8, 3600, 0.5, ?, ?, 0)`,
    )
    .run(symbol, '0x' + '9'.repeat(40), symbol + ' / USD', kind);
}

function addStockToken(address: string, symbol: string) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO stock_tokens
         (address, symbol, name, decimals, current_multiplier, status, synced_at)
       VALUES (?, ?, ?, 18, '1', 'active', 0)`,
    )
    .run(address, symbol, symbol);
}

/** One v4 pool row, with the classification the indexer would have written. */
function addPool(
  poolId: string, stockSymbol: string, stockSide: number,
  pairedToken: string, quoteKind: string, swaps: number,
) {
  const db = getDb();
  const [c0, c1] = stockSide === 0
    ? [stockSymbol === 'NVDA' ? NVDA_TOKEN : AAPL_TOKEN, pairedToken]
    : [pairedToken, stockSymbol === 'NVDA' ? NVDA_TOKEN : AAPL_TOKEN];
  db.prepare(
    `INSERT OR REPLACE INTO pools
       (pool_id, currency0, currency1, fee, tick_spacing, hooks, init_block, init_tx,
        init_sqrt_px, init_tick, stock_side, stock_symbol, paired_token, quote_kind)
     VALUES (?, ?, ?, 3000, 60, ?, 1, ?, '1', 0, ?, ?, ?, ?)`,
  ).run(poolId, c0, c1, '0x' + '0'.repeat(40), '0x' + '1'.repeat(64),
        stockSide, stockSymbol, pairedToken, quoteKind);
  db.prepare(
    `INSERT OR REPLACE INTO pool_volume
       (pool_key, protocol, from_block, to_block, from_ts, to_ts, swaps,
        abs_amount0, abs_amount1, updated_at)
     VALUES (?, 'v4', 1, 2, 0, 0, ?, '0', '0', 0)`,
  ).run(poolId, swaps);
}

const P_MEME = '0x' + 'a'.repeat(64);
const P_USDG = '0x' + 'b'.repeat(64);
const P_STOCK = '0x' + 'c'.repeat(64);
const P_NOFEED = '0x' + 'd'.repeat(64);

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM pools');
  db.exec('DELETE FROM pool_volume');
  db.exec('DELETE FROM feeds');
  db.exec('DELETE FROM stock_tokens');
  addFeed('NVDA');
  addFeed('AAPL');
  addStockToken(NVDA_TOKEN, 'NVDA');
  addStockToken(AAPL_TOKEN, 'AAPL');
});

describe('poolsToSample', () => {
  it('puts a measurable pool ahead of a busier unmeasurable one', () => {
    addPool(P_MEME, 'NVDA', 0, MEME, 'stock', 10_000);
    addPool(P_USDG, 'NVDA', 0, TOKENS.usdg, 'stock', 5);

    const picked = poolsToSample(10).map((p) => p.key);
    expect(picked[0]).toBe(P_USDG);
    expect(picked[1]).toBe(P_MEME);
  });

  it('still samples the unmeasurable pool — it is demoted, not dropped', () => {
    addPool(P_MEME, 'NVDA', 0, MEME, 'stock', 10_000);
    addPool(P_USDG, 'NVDA', 0, TOKENS.usdg, 'stock', 5);

    expect(poolsToSample(10)).toHaveLength(2);
  });

  it('keeps the swaps ordering within the measurable tier', () => {
    addPool(P_USDG, 'NVDA', 0, TOKENS.usdg, 'stock', 5);
    addPool(P_STOCK, 'NVDA', 0, AAPL_TOKEN, 'stock', 900);

    expect(poolsToSample(10).map((p) => p.key)).toEqual([P_STOCK, P_USDG]);
  });

  /**
   * A stock with no Chainlink feed cannot produce a deviation either, however
   * ordinary its paired side is. 159 of 194 stock tokens are in this position,
   * so it is the common case, not an edge one.
   */
  it('treats a stock with no feed as unmeasurable', () => {
    getDb().prepare('DELETE FROM feeds WHERE symbol = ?').run('AAPL');
    addPool(P_NOFEED, 'AAPL', 0, TOKENS.usdg, 'stock', 10_000);
    addPool(P_USDG, 'NVDA', 0, TOKENS.usdg, 'stock', 5);

    expect(poolsToSample(10).map((p) => p.key)).toEqual([P_USDG, P_NOFEED]);
  });

  /**
   * The limit is a budget, and the point of the ranking is that the budget
   * buys measurable rows first.
   */
  it('spends a tight budget on the measurable pool', () => {
    addPool(P_MEME, 'NVDA', 0, MEME, 'stock', 10_000);
    addPool(P_USDG, 'NVDA', 0, TOKENS.usdg, 'stock', 5);

    expect(poolsToSample(1).map((p) => p.key)).toEqual([P_USDG]);
  });

  it('reads the stock on either side of the pool', () => {
    addPool(P_USDG, 'NVDA', 1, TOKENS.usdg, 'stock', 5);
    expect(poolsToSample(10).map((p) => p.key)).toEqual([P_USDG]);
  });
});
