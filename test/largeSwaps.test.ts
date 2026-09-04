import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The trades the volume measurement used to throw away.
 *
 * No chain here: a swap is a log row, and everything worth testing is what
 * happens to it afterwards — which side counts, which direction it was, what
 * happens when the stock has no price, and whether measuring the same window
 * twice records it twice.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'large-swaps-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const {
  TopSwaps, poolFacts, selectLargeSwaps, saveLargeSwaps, largeSwapsFor, largestSwaps,
} = await import('../src/volume/largeSwaps.js');
const { registerTrades } = await import('../src/api/routes/trades.js');
const { answerQuestion } = await import('../src/answer/answer.js');
const { classify, resetSymbolCache } = await import('../src/answer/intent.js');

const NVDA = '0x1111111111111111111111111111111111111111';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const POOL = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;

const app = Fastify();

const swap = (over: Partial<Parameters<TopSwapsType['offer']>[0]> = {}) => ({
  poolKey: POOL, protocol: 'v3' as const, txHash: '0xaa', logIndex: 0, block: 100,
  amount0: 1000n, amount1: -1n * E18, ...over,
});
type TopSwapsType = InstanceType<typeof TopSwaps>;

beforeAll(async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO stock_tokens (address, symbol, name, decimals, current_multiplier, status, synced_at)
     VALUES (?, 'NVDA', 'NVIDIA', 18, '1', 'active', 0)`,
  ).run(NVDA);
  db.prepare(
    `INSERT INTO pools_v3 (address, token0, token1, fee, tick_spacing, init_block, init_tx,
                           stock_side, stock_symbol, paired_token, quote_kind)
     VALUES (?, ?, ?, 500, 10, 1, '0xtx', 1, 'NVDA', ?, 'stock')`,
  ).run(POOL, USDG, NVDA, USDG);
  registerTrades(app);
  await app.ready();
  resetSymbolCache();
});

beforeEach(() => getDb().exec('DELETE FROM large_swaps'));

describe('ranking while the logs go past', () => {
  const facts = () => poolFacts();

  it('keeps the biggest and drops the rest', () => {
    const top = new TopSwaps(new Map([[POOL, 1]]), 2);
    for (const n of [1n, 9n, 5n, 3n]) {
      top.offer(swap({ logIndex: Number(n), amount1: -n * E18 }));
    }
    const kept = top.all().map((c) => Number(-c.amount1 / E18));
    expect(kept).toEqual([9, 5]);
  });

  /** The stock side is what ranks. Ranking on the paired side would compare
   * a launchpad token against a dollar. */
  it('ranks on the stock side, not on the pool side', () => {
    const top = new TopSwaps(new Map([[POOL, 1]]), 1);
    top.offer(swap({ logIndex: 1, amount0: 999_999n, amount1: -1n * E18 }));
    top.offer(swap({ logIndex: 2, amount0: 1n, amount1: -50n * E18 }));
    expect(top.all()[0]!.logIndex).toBe(2);
  });

  it('ignores a pool the caller did not list as stock-paired', () => {
    const top = new TopSwaps(new Map([[POOL, 1]]));
    top.offer(swap({ poolKey: '0x9999999999999999999999999999999999999999' }));
    expect(top.size()).toBe(0);
  });

  it('finds the stock side and its decimals from the pool tables', () => {
    const f = facts().get(POOL)!;
    expect(f).toMatchObject({ stockSymbol: 'NVDA', stockSide: 1, decimals: 18 });
  });
});

describe('pricing what was ranked', () => {
  const facts = () => poolFacts();
  const prices = new Map([['NVDA', 200]]);

  it('prices the stock side and reads the direction from the sign', () => {
    // Negative = the token left the pool = the taker received it = a buy.
    const [buy] = selectLargeSwaps([swap({ amount1: -50n * E18 })], facts(), prices, 0);
    expect(buy).toMatchObject({ side: 'buy', stockUnits: 50, usd: 10_000 });

    const [sell] = selectLargeSwaps([swap({ amount1: 50n * E18 })], facts(), prices, 0);
    expect(sell!.side).toBe('sell');
  });

  it('drops what is below the floor', () => {
    expect(selectLargeSwaps([swap({ amount1: -1n * E18 })], facts(), prices, 5000)).toHaveLength(0);
    expect(selectLargeSwaps([swap({ amount1: -30n * E18 })], facts(), prices, 5000)).toHaveLength(1);
  });

  /**
   * 159 of 194 stock tokens have no feed. Dropping their trades would leave a
   * table that silently covered 35 stocks and read as though it covered all.
   */
  it('keeps an unpriceable trade, with the reason, instead of dropping it', () => {
    const [row] = selectLargeSwaps([swap({ amount1: -50n * E18 })], facts(), new Map(), 5000);
    expect(row).toMatchObject({ usd: null, usdReason: 'no_chainlink_feed_for_stock', stockUnits: 50 });
  });
});

describe('storing', () => {
  const facts = () => poolFacts();
  const prices = new Map([['NVDA', 200]]);

  it('records the same swap once however often the window is measured', () => {
    const rows = selectLargeSwaps([swap({ amount1: -50n * E18 })], facts(), prices, 0);
    expect(saveLargeSwaps(rows)).toBe(1);
    expect(saveLargeSwaps(rows)).toBe(0);
    expect(largeSwapsFor('NVDA')).toHaveLength(1);
  });

  it('orders by USD, with unpriced trades last rather than first', () => {
    saveLargeSwaps([
      ...selectLargeSwaps([swap({ logIndex: 1, amount1: -10n * E18 })], facts(), prices, 0),
      ...selectLargeSwaps([swap({ logIndex: 2, amount1: -60n * E18 })], facts(), prices, 0),
      ...selectLargeSwaps([swap({ logIndex: 3, amount1: -99n * E18 })], facts(), new Map(), 0),
    ]);
    const rows = largeSwapsFor('NVDA');
    expect(rows.map((r) => r.logIndex)).toEqual([2, 1, 3]);
    expect(largestSwaps().map((r) => r.logIndex)).toEqual([2, 1]);
  });
});

describe('GET /trades', () => {
  it('says nothing is recorded rather than implying nothing happened', async () => {
    const body = (await app.inject({ method: 'GET', url: '/trades?symbol=NVDA' })).json();
    expect(body.trades).toHaveLength(0);
    expect(body.note).toMatch(/nothing recorded yet/);
    expect(body.measurement.measuredAt).toBeNull();
  });

  it('404s a ticker that is not on this chain', async () => {
    expect((await app.inject({ method: 'GET', url: '/trades?symbol=ZZZZ' })).statusCode).toBe(404);
  });

  it('rejects an absurd limit', async () => {
    expect((await app.inject({ method: 'GET', url: '/trades?limit=5000' })).statusCode).toBe(400);
  });

  it('returns what was recorded, and says how stale it is', async () => {
    saveLargeSwaps(selectLargeSwaps([swap({ amount1: -60n * E18 })], poolFacts(), new Map([['NVDA', 200]]), 0));
    const body = (await app.inject({ method: 'GET', url: '/trades?symbol=NVDA' })).json();
    expect(body.trades[0]).toMatchObject({ side: 'buy', usd: 12_000, stockSymbol: 'NVDA' });
    expect(body.measurement.measuredAt).not.toBeNull();
  });
});

describe('/ask about trades', () => {
  it('hears a trade question as one, not as a price question', () => {
    expect(classify('what was the biggest NVDA trade today?').kind).toBe('large_trades');
    expect(classify('any whales in NVDA?').kind).toBe('large_trades');
    // Still a price question, and must not be stolen by the new rule.
    expect(classify('what is NVDA worth?').kind).toBe('price');
  });

  it('says it has nothing recorded rather than guessing', async () => {
    const a = await answerQuestion('what was the biggest NVDA trade?');
    expect(a.answered).toBe(false);
    expect(a.text).toMatch(/no priced trade recorded/);
    expect(a.reproduce).toMatch(/\/trades\?symbol=NVDA/);
  });

  it('answers from the record, citing only its own facts', async () => {
    saveLargeSwaps(selectLargeSwaps([swap({ amount1: -60n * E18 })], poolFacts(), new Map([['NVDA', 200]]), 0));
    const a = await answerQuestion('what was the biggest NVDA trade?');
    expect(a.answered).toBe(true);
    expect(a.facts).toMatchObject({ symbol: 'NVDA', usd: 12_000, side: 'buy' });
  });
});
