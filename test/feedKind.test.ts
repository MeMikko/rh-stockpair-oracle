import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Reference feeds, and the line between them and coverage.
 *
 * The registry kept only feeds named `Robinhood…`/`RH…`, which is right for
 * equities and was quietly wrong for the other side of a pool: two of the
 * twenty busiest stock-paired pools are stock/WETH, and they were unmeasurable
 * for a reason that was ours rather than the chain's.
 *
 * The risk in fixing it is the opposite error — an ETH/USD feed counted as
 * coverage of a stock token, inflating the one number this service publishes
 * about its own limits. So both directions are asserted here.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'feed-kind-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const { saveFeeds, loadFeeds, loadAllFeeds, feedFor, referenceFeed } = await import(
  '../src/registry/feeds.js'
);
const { computeCoverage } = await import('../src/registry/coverage.js');
const { computeDeviation } = await import('../src/pricing/deviation.js');
const { TOKENS } = await import('../config/addresses.js');

const feed = (symbol: string, kind: 'stock' | 'reference') => ({
  symbol,
  proxyAddress: `0x${symbol.toLowerCase().padEnd(40, '0')}`,
  secondaryProxy: null,
  decimals: 8,
  heartbeat: 3600,
  threshold: 0.5,
  marketHours: null,
  name: `${symbol} / USD`,
  kind,
});

beforeEach(() => {
  getDb().exec('DELETE FROM feeds');
  getDb().exec('DELETE FROM stock_tokens');
});

describe('a reference feed is not coverage', () => {
  it('is stored, and readable as itself', () => {
    saveFeeds([feed('ETH', 'reference')]);
    expect(referenceFeed('ETH')?.symbol).toBe('ETH');
    expect(loadAllFeeds()).toHaveLength(1);
  });

  it('never appears among the equity feeds', () => {
    saveFeeds([feed('NVDA', 'stock'), feed('ETH', 'reference')]);
    expect(loadFeeds().map((f) => f.symbol)).toEqual(['NVDA']);
  });

  /** The number this service publishes about its own limits must not inflate. */
  it('does not count toward /coverage', () => {
    getDb()
      .prepare(
        `INSERT INTO stock_tokens (address, symbol, name, decimals, current_multiplier, status, synced_at)
         VALUES ('0x01', 'NVDA', 'NVIDIA', 18, '1', 'active', 0)`,
      )
      .run();
    saveFeeds([feed('ETH', 'reference')]);
    const c = computeCoverage();
    expect(c.total).toBe(1);
    expect(c.covered).toEqual([]);
  });

  /** A stock lookup must never be satisfied by a reference row. */
  it('cannot answer a stock feed lookup', () => {
    saveFeeds([feed('ETH', 'reference')]);
    expect(feedFor('ETH')).toBeNull();
  });

  it('does not shadow an equity feed of the same name', () => {
    saveFeeds([feed('ETH', 'stock')]);
    expect(feedFor('ETH')?.kind).toBe('stock');
    expect(referenceFeed('ETH')).toBeNull();
  });
});

describe('a stock/WETH pool', () => {
  const oracle = { priceUsd: 200, updatedAt: 0, staleSeconds: 0, roundId: '1', decimals: 8 };

  /**
   * The honest state before this change, and still the honest state on a chain
   * that publishes no ETH/USD feed: null with a reason, never a number derived
   * from nothing.
   */
  it('stays unmeasurable when no ETH reference is published', async () => {
    const r = await computeDeviation('NVDA', TOKENS.weth, 0.5, oracle as never, new Map());
    expect(r.deviation).toBeNull();
    expect(r.reason).toBe('no_eth_usd_reference_configured');
  });

  it('is still unmeasurable when only an equity ETH feed exists', async () => {
    saveFeeds([feed('ETH', 'stock')]);
    const r = await computeDeviation('NVDA', TOKENS.weth, 0.5, oracle as never, new Map());
    expect(r.reason).toBe('no_eth_usd_reference_configured');
  });

  it('leaves a non-WETH unpriceable pair alone', async () => {
    saveFeeds([feed('ETH', 'reference')]);
    const r = await computeDeviation(
      'NVDA', '0x00000000000000000000000000000000deadbeef', 0.5, oracle as never, new Map(),
    );
    expect(r.reason).toBe('paired_token_has_no_usd_reference');
  });
});
