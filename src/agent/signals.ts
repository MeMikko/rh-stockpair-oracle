import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { upcomingActions } from '../corporate/calendar.js';
import { computeCoverage } from '../registry/coverage.js';
import { readGas } from '../pricing/gas.js';
import { marketStatus } from '../pricing/marketHours.js';

export type Severity = 'info' | 'notable' | 'high';

export interface Signal {
  id: string;
  kind: string;
  severity: Severity;
  summary: string;
  /** Every number a post is allowed to cite. Drafts are checked against this. */
  facts: Record<string, string | number | boolean | null>;
  /** The endpoint call that reproduces the claim. */
  reproduce: string;
  detectedAt: number;
}

/**
 * A signal id is a hash of the observation, not of the moment it was seen, so
 * re-running the scan does not queue the same post twice. Anything that should
 * re-fire when it changes must be part of the key.
 */
function signalId(kind: string, key: string): string {
  return createHash('sha256').update(`${kind}:${key}`).digest('hex').slice(0, 16);
}

export interface Thresholds {
  /** Minimum |deviation| vs Chainlink to be worth mentioning. */
  deviationFraction: number;
  /** Only flag actions this many days out or fewer. */
  actionHorizonDays: number;
  /** An action must touch at least this many indexed pools. */
  minAffectedPools: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  deviationFraction: 0.02,
  actionHorizonDays: 7,
  minAffectedPools: 1,
};

/**
 * Corporate action approaching on a stock that prices indexed pools.
 *
 * This is the signal nobody else can produce: the calendar is public and the
 * pool set is public, but nothing joins them. On this chain the adjustment
 * lands through the ERC-8056 multiplier, so every pool quoted in that stock
 * reprices at once.
 */
export function detectCorporateActions(t: Thresholds = DEFAULT_THRESHOLDS, now = new Date()): Signal[] {
  return upcomingActions(t.actionHorizonDays, now)
    .filter((a) => a.status !== 'COMPLETED' && a.affectedPools >= t.minAffectedPools)
    .map((a) => ({
      id: signalId('corporate_action', `${a.id}:${a.processDate}:${a.affectedPools}`),
      kind: 'corporate_action',
      severity: (a.affectedPools >= 5 ? 'high' : 'notable') as Severity,
      summary: `${a.tokenSymbol} ${a.type.toLowerCase().replace('_', ' ')} on ${a.processDate} reprices ${a.affectedPools} indexed pool(s)`,
      facts: {
        symbol: a.tokenSymbol,
        actionType: a.type,
        processDate: a.processDate,
        daysAway: a.daysAway,
        affectedPools: a.affectedPools,
        rate: (a.detail.rate as string) ?? null,
        tokenAddress: a.tokenAddress,
      },
      reproduce: `GET /corporate-actions?withinDays=${t.actionHorizonDays}`,
      detectedAt: Date.now(),
    }));
}

/**
 * Pool price disagreeing with Chainlink while the underlying market is shut.
 *
 * Only computable where the non-stock side has its own USD reference, which is
 * the same constraint /quote enforces -- so this never fabricates a deviation
 * for a memecoin pool.
 */
export function detectDeviations(t: Thresholds = DEFAULT_THRESHOLDS, now = new Date()): Signal[] {
  const market = marketStatus(now);
  const rows = getDb().prepare(
    `SELECT p.pool_id, p.stock_symbol FROM pools p
     JOIN feeds f ON f.symbol = p.stock_symbol
     WHERE p.quote_kind = 'stock' AND p.paired_token IN
       (SELECT address FROM token_meta WHERE source = 'builtin')`,
  ).all() as { pool_id: string; stock_symbol: string }[];

  // Deviation itself is computed by /quote against live state; the scanner
  // records candidates so the caller can evaluate them without this module
  // duplicating pricing logic.
  return rows.map((r) => ({
    id: signalId('deviation_candidate', `${r.pool_id}:${market.etDate}:${market.session}`),
    kind: 'deviation_candidate',
    severity: 'info' as Severity,
    summary: `${r.stock_symbol} pool has a USD reference and the market is ${market.session}`,
    facts: {
      poolId: r.pool_id, symbol: r.stock_symbol,
      session: market.session, marketOpen: market.isOpen,
      thresholdFraction: t.deviationFraction,
    },
    reproduce: `GET /quote?pool=${r.pool_id}`,
    detectedAt: Date.now(),
  }));
}

/** Oracle coverage across the stock-token universe. */
export function detectCoverage(): Signal[] {
  const c = computeCoverage();
  if (c.total === 0) return [];
  return [{
    id: signalId('oracle_coverage', `${c.covered.length}/${c.total}`),
    kind: 'oracle_coverage',
    severity: 'notable',
    summary: `${c.uncovered.length} of ${c.total} stock tokens have no Chainlink feed`,
    facts: {
      total: c.total, covered: c.covered.length, uncovered: c.uncovered.length,
      coveragePercent: Number((c.coverageRatio * 100).toFixed(1)),
    },
    reproduce: 'GET /coverage',
    detectedAt: Date.now(),
  }];
}

/**
 * Change in the L1 gas subsidy.
 *
 * Deliberately keyed off the sampled window rather than the instantaneous
 * reading, because that reading flaps: a single non-zero blip was observed
 * reverting to zero minutes later, and firing on it would publish a false
 * "subsidy has ended".
 */
export async function detectGasSubsidy(): Promise<Signal[]> {
  const g = await readGas();
  const e = g.subsidy.evidence;
  if (e.samples < 10) return []; // not enough evidence to say anything yet
  if (e.freeAcrossWindow) return [];

  return [{
    id: signalId('gas_subsidy', `ended:${e.nonZeroSamples}/${e.samples}`),
    kind: 'gas_subsidy',
    severity: 'high',
    summary: `L1 data is being charged in ${e.nonZeroSamples} of ${e.samples} recent samples; the launch subsidy may have ended`,
    facts: {
      nonZeroSamples: e.nonZeroSamples, samples: e.samples,
      windowSeconds: e.windowSeconds,
      perL1CalldataUnit: g.perL1CalldataUnit,
      l1BaseFeeEstimate: g.l1BaseFeeEstimate,
      baseFeePerGas: g.baseFeePerGas,
    },
    reproduce: 'GET /gas',
    detectedAt: Date.now(),
  }];
}

export function saveSignals(signals: Signal[]): { inserted: number } {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO signals (id, kind, severity, summary, facts_json, reproduce, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  );
  let inserted = 0;
  db.exec('BEGIN');
  for (const s of signals) {
    const r = stmt.run(s.id, s.kind, s.severity, s.summary,
                       JSON.stringify(s.facts), s.reproduce, s.detectedAt);
    if (Number(r.changes) > 0) inserted++;
  }
  db.exec('COMMIT');
  return { inserted };
}

export function loadSignal(id: string): Signal | null {
  const r = getDb().prepare('SELECT * FROM signals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id), kind: String(r.kind), severity: String(r.severity) as Severity,
    summary: String(r.summary), facts: JSON.parse(String(r.facts_json)),
    reproduce: String(r.reproduce), detectedAt: Number(r.detected_at),
  };
}
