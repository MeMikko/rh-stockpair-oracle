import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The record, and what is said about it.
 *
 * Nothing here reads a chain: a snapshot is a row, and every property worth
 * testing is about what happens to rows afterwards. The failure this file
 * mostly guards against is not a wrong number but a confident one — an answer
 * built on two samples, a mean that quietly excluded the stocks with no feed,
 * or a series that filled in its own gaps.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'history-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const {
  bestSampledPool, driftBySession, historyDepth, snapshotsForPool, volumeHistory,
} = await import('../src/history/series.js');
const { saveSnapshots, pruneHistory } = await import('../src/history/snapshot.js');
type Snapshot = import('../src/history/snapshot.js').Snapshot;
const { detectClosedMarketDrift } = await import('../src/agent/signals.js');
const { registerHistory } = await import('../src/api/routes/history.js');
const { answerQuestion } = await import('../src/answer/answer.js');
const { resetSymbolCache } = await import('../src/answer/intent.js');

const NVDA = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const HOUR = 3_600_000;

const app = Fastify();

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    poolKey: POOL, protocol: 'v3', at: Date.now(), block: 100, stockSymbol: 'NVDA',
    spot: 0.0043, sqrtPriceX96: '79228162514264337593543950336', impliedUsd: 1,
    poolStockUsd: 229, oracleUsd: 229, deviation: 0,
    deviationReason: null, liquidity: '1', marketSession: 'regular', marketOpen: true,
    ...over,
  };
}

/** n samples in one session, each with the given |deviation|. */
function series(session: string, open: boolean, dev: number, n: number, base: number): Snapshot[] {
  return Array.from({ length: n }, (_, i) =>
    snap({
      at: base + i * 60_000,
      deviation: dev,
      marketSession: session,
      marketOpen: open,
      poolStockUsd: 229 + i,
    }),
  );
}

beforeAll(async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO stock_tokens (address, symbol, name, decimals, current_multiplier, status, synced_at)
     VALUES (?, 'NVDA', 'NVIDIA', 18, '1', 'active', ?)`,
  ).run(NVDA, Date.now());
  registerHistory(app);
  await app.ready();
  resetSymbolCache();
});

beforeEach(() => {
  getDb().exec('DELETE FROM quote_snapshots');
  getDb().exec('DELETE FROM pool_volume_history');
  getDb().exec('DELETE FROM signals');
});

describe('keeping the record', () => {
  it('stores a snapshot without rounding the deviation away', () => {
    // 0.0123% -- the size of drift that matters and the size a REAL column
    // would have quietly flattened.
    saveSnapshots([snap({ deviation: 0.000123, at: 1_000 })]);
    expect(snapshotsForPool(POOL, 0)[0]!.deviation).toBe(0.000123);
  });

  it('treats the same pool and moment as one observation, not two', () => {
    saveSnapshots([snap({ at: 5_000 })]);
    saveSnapshots([snap({ at: 5_000, poolStockUsd: 999 })]);
    const rows = snapshotsForPool(POOL, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.poolStockUsd).toBe(229);
  });

  it('keeps a missing deviation missing rather than calling it zero', () => {
    saveSnapshots([snap({ at: 7_000, deviation: null, deviationReason: 'no_feed' })]);
    const row = snapshotsForPool(POOL, 0)[0]!;
    expect(row.deviation).toBeNull();
    expect(row.deviationReason).toBe('no_feed');
  });

  it('prunes past the retention window and leaves the rest', () => {
    const now = Date.now();
    saveSnapshots([snap({ at: now - 400 * 86_400_000 }), snap({ at: now - HOUR })]);
    const pruned = pruneHistory(180);
    expect(pruned.snapshots).toBe(1);
    expect(snapshotsForPool(POOL, 0)).toHaveLength(1);
  });

  it('reports depth, and reports it as zero when there is none', () => {
    expect(historyDepth().snapshots).toBe(0);
    saveSnapshots([snap({ at: 1_000 }), snap({ at: 2_000 })]);
    const d = historyDepth();
    expect(d.snapshots).toBe(2);
    expect(d.since).toBe(1_000);
    expect(d.symbols).toBe(1);
  });
});

/**
 * The failure HoodGrow found 60 days too late, on this deployment's third hour.
 *
 * Its prices were quote mids that could go one-sided; ours come from pool
 * reserves and only move because someone traded. The rule is the same shape
 * for a different reason: a trade large enough to move a pool 10% in a quarter
 * hour sets a price that describes that order, not a market, and averaging it
 * into "how far this pool drifts overnight" answers a different question.
 */
describe('prices not fit to compute a statistic from', () => {
  const base = Date.now() - 2 * HOUR;

  it('flags a jump between adjacent samples', () => {
    saveSnapshots([snap({ at: base, spot: 100 })]);
    saveSnapshots([snap({ at: base + 60_000, spot: 130 })]);
    const rows = snapshotsForPool(POOL, 0);
    expect(rows[0]!.priceFlag).toBeNull();
    expect(rows[1]!.priceFlag).toBe('adjacent-jump');
  });

  /** Two days of ordinary movement is not a jump. This bound is why. */
  it('does not compare across a gap in the record', () => {
    saveSnapshots([snap({ at: base, spot: 100 })]);
    saveSnapshots([snap({ at: base + 3 * 86_400_000, spot: 300 })]);
    expect(snapshotsForPool(POOL, 0)[1]!.priceFlag).toBeNull();
  });

  it('keeps the raw price, so a future rule can re-judge the past', () => {
    saveSnapshots([snap({ at: base, sqrtPriceX96: '12345' })]);
    expect(snapshotsForPool(POOL, 0)[0]!.sqrtPriceX96).toBe('12345');
  });

  it('excludes a flagged sample from the mean and counts it', () => {
    saveSnapshots([
      ...series('closed', false, 0.02, 5, base),
      snap({ at: base + 6 * 60_000, spot: 999, deviation: 0.9, marketSession: 'closed', marketOpen: false }),
    ]);
    const closed = driftBySession('NVDA', 0).find((s) => s.session === 'closed')!;
    expect(closed.flagged).toBe(1);
    expect(closed.samples).toBe(6);
    expect(closed.usable).toBe(5);
    // 0.9 would have dragged a mean of 0.02 to 0.167 had it been included.
    expect(closed.meanAbsDeviation).toBeCloseTo(0.02, 6);
  });

  it('reports the flagged count in the free depth on /health', () => {
    saveSnapshots([snap({ at: base, spot: 100 })]);
    saveSnapshots([snap({ at: base + 60_000, spot: 130 })]);
    expect(historyDepth().flagged).toBe(1);
  });

  /** A guard counted on raw samples would pass on eleven unusable ones. */
  it('does not publish a finding built on flagged samples', () => {
    saveSnapshots([
      ...series('regular', true, 0.001, 20, base),
      ...series('closed', false, 0.05, 3, base + HOUR),
    ]);
    // Nine more closed samples, every one a flagged jump: enough to clear a
    // raw-count guard, not one of them usable.
    for (let i = 0; i < 9; i += 1) {
      saveSnapshots([
        snap({ at: base + 2 * HOUR + i * 120_000, spot: 100, deviation: 0.05, marketSession: 'closed', marketOpen: false }),
        snap({ at: base + 2 * HOUR + i * 120_000 + 60_000, spot: 130, deviation: 0.05, marketSession: 'closed', marketOpen: false }),
      ]);
    }
    const closed = driftBySession('NVDA', 0).find((s) => s.session === 'closed')!;
    expect(closed.samples).toBeGreaterThanOrEqual(12);
    expect(closed.usable).toBeLessThan(12);
    expect(detectClosedMarketDrift()).toHaveLength(0);
  });
});

describe('drift split by session', () => {
  const base = Date.now() - 3 * HOUR;

  it('separates open from closed', () => {
    saveSnapshots([
      ...series('regular', true, 0.001, 20, base),
      ...series('closed', false, 0.02, 20, base + HOUR),
    ]);
    const stats = driftBySession('NVDA', 0);
    expect(stats.find((s) => s.session === 'regular')!.meanAbsDeviation).toBeCloseTo(0.001, 6);
    expect(stats.find((s) => s.session === 'closed')!.meanAbsDeviation).toBeCloseTo(0.02, 6);
  });

  /**
   * 159 of 194 stock tokens have no feed. A mean over "whatever had a number"
   * would be a mean over a self-selected third of the subject, presented as
   * though it covered all of it.
   */
  it('counts feedless samples separately instead of dropping them', () => {
    saveSnapshots([
      ...series('closed', false, 0.02, 5, base),
      ...Array.from({ length: 5 }, (_, i) =>
        snap({ at: base + 10 * HOUR + i * 60_000, deviation: null, deviationReason: 'no_feed', marketSession: 'closed', marketOpen: false }),
      ),
    ]);
    const closed = driftBySession('NVDA', 0).find((s) => s.session === 'closed')!;
    expect(closed.samples).toBe(10);
    expect(closed.unknowable).toBe(5);
    expect(closed.meanAbsDeviation).toBeCloseTo(0.02, 6);
  });

  it('uses absolute deviation, so opposite drifts do not cancel', () => {
    saveSnapshots([
      snap({ at: base, deviation: 0.02, marketSession: 'closed', marketOpen: false }),
      snap({ at: base + 60_000, deviation: -0.02, marketSession: 'closed', marketOpen: false }),
    ]);
    const closed = driftBySession('NVDA', 0).find((s) => s.session === 'closed')!;
    expect(closed.meanAbsDeviation).toBeCloseTo(0.02, 6);
  });
});

describe('what the agent will say about it', () => {
  const base = Date.now() - 2 * HOUR;

  it('refuses to publish a drift finding from too few samples', () => {
    saveSnapshots([
      ...series('regular', true, 0.001, 3, base),
      ...series('closed', false, 0.05, 3, base + HOUR),
    ]);
    expect(detectClosedMarketDrift()).toHaveLength(0);
  });

  it('publishes one when both sides are measured and the gap is real', () => {
    saveSnapshots([
      ...series('regular', true, 0.001, 20, base),
      ...series('closed', false, 0.05, 20, base + HOUR),
    ]);
    const signals = detectClosedMarketDrift();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.kind).toBe('closed_market_drift');
    expect(signals[0]!.facts.closedMeanPercent).toBe(5);
    expect(signals[0]!.reproduce).toMatch(/GET \/history\?symbol=NVDA/);
  });

  /** A drift that is not wider when closed is not a finding. */
  it('says nothing when closed drift does not exceed open drift', () => {
    saveSnapshots([
      ...series('regular', true, 0.02, 20, base),
      ...series('closed', false, 0.02, 20, base + HOUR),
    ]);
    expect(detectClosedMarketDrift()).toHaveLength(0);
  });

  it('reports the same standing observation under one id', () => {
    saveSnapshots([
      ...series('regular', true, 0.001, 20, base),
      ...series('closed', false, 0.05, 20, base + HOUR),
    ]);
    const a = detectClosedMarketDrift()[0]!;
    const b = detectClosedMarketDrift(undefined, Date.now() + 86_400_000)[0]!;
    expect(b.id).toBe(a.id);
  });
});

describe('/ask about the past', () => {
  const base = Date.now() - 2 * HOUR;

  /**
   * The distinction the whole feature turns on: not knowing yet is a different
   * answer from not knowing, and only one of them should sound like a limit
   * of this deployment.
   */
  it('says it has not recorded enough rather than guessing', async () => {
    const a = await answerQuestion('what did NVDA do over the past day?');
    expect(a.answered).toBe(false);
    expect(a.text).toMatch(/no recorded history|not enough/i);
    expect(a.reproduce).toMatch(/\/history\?symbol=NVDA/);
  });

  it('answers from the record once there is one, citing only its own facts', async () => {
    saveSnapshots(series('regular', true, 0.001, 20, base));
    const a = await answerQuestion('what did NVDA do over the past day?');
    expect(a.answered).toBe(true);
    expect(a.intent.kind).toBe('history');
    expect(a.facts.samples).toBe(20);
    expect(a.reproduce).toMatch(/\/history\?symbol=NVDA/);
  });

  it('routes a closed-market question to the drift answer, not to price', async () => {
    saveSnapshots([
      ...series('regular', true, 0.001, 20, base),
      ...series('closed', false, 0.05, 20, base + HOUR),
    ]);
    const a = await answerQuestion('how far does NVDA drift while the market is closed?');
    expect(a.intent.kind).toBe('market_drift');
    expect(a.answered).toBe(true);
    expect(a.facts.closedMeanPercent).toBe(5);
  });
});

describe('GET /history', () => {
  it('asks for a pool or a symbol, and says where to see the depth free', async () => {
    const res = await app.inject({ method: 'GET', url: '/history' });
    expect(res.statusCode).toBe(400);
    expect(res.json().note).toMatch(/\/health/);
  });

  it('404s a ticker that is not on this chain', async () => {
    const res = await app.inject({ method: 'GET', url: '/history?symbol=ZZZZ' });
    expect(res.statusCode).toBe(404);
  });

  /**
   * 200, not 404: the ticker is real and the question is answerable in
   * principle. What is missing is elapsed time, and the two are different
   * problems for the caller.
   */
  it('answers a real ticker with an empty series rather than a miss', async () => {
    const res = await app.inject({ method: 'GET', url: '/history?symbol=NVDA' });
    expect(res.statusCode).toBe(200);
    expect(res.json().samples).toBe(0);
    expect(res.json().note).toMatch(/nothing has been recorded yet/);
  });

  it('rejects an absurd window instead of scanning for it', async () => {
    const res = await app.inject({ method: 'GET', url: '/history?symbol=NVDA&hours=99999' });
    expect(res.statusCode).toBe(400);
  });

  it('returns the series and the session split once there is one', async () => {
    saveSnapshots(series('closed', false, 0.02, 10, Date.now() - HOUR));
    const body = (await app.inject({ method: 'GET', url: '/history?symbol=NVDA&hours=24' })).json();
    expect(body.samples).toBe(10);
    expect(body.snapshots).toHaveLength(10);
    expect(body.driftBySession[0].session).toBe('closed');
  });
});

describe('volume history', () => {
  it('keeps each window rather than replacing the last', () => {
    const db = getDb();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO pool_volume_history
         (pool_key, protocol, to_ts, from_block, to_block, from_ts, swaps,
          abs_amount0, abs_amount1, measured_at)
       VALUES (?, 'v3', ?, 1, 2, 0, ?, '0', '0', 0)`,
    );
    ins.run(POOL, 1_000, 10);
    ins.run(POOL, 2_000, 20);
    ins.run(POOL, 2_000, 999);   // same window seen twice: still one row
    const points = volumeHistory(POOL, 0);
    expect(points.map((p) => p.swaps)).toEqual([10, 20]);
  });
});
