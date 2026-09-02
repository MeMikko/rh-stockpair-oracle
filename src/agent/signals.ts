import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { upcomingActions } from '../corporate/calendar.js';
import { computeCoverage } from '../registry/coverage.js';
import { readGas } from '../pricing/gas.js';
import { marketStatus } from '../pricing/marketHours.js';
import { agentIdentity } from '../../config/agent.js';

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
  // 30 days, not 7. At 7 the scanner missed the largest action on the chain:
  // NVDA's 2026-10-01 dividend reprices 9,228 indexed pools and sat 29 days
  // out. A corporate action is useful precisely because it is known in
  // advance, so a horizon shorter than the announcement lead time throws away
  // the signal's whole advantage.
  actionHorizonDays: 30,
  minAffectedPools: 1,
};

/**
 * Minimum share the smaller protocol must hold before the split is worth
 * saying out loud. Below this it is a footnote, not a finding.
 */
const PROTOCOL_SPLIT_MIN_SHARE = 0.1;

/**
 * Retained gas samples required before the agent will say anything about the
 * subsidy at all. Paired with a majority test in detectGasSubsidy.
 */
const GAS_SUBSIDY_MIN_SAMPLES = 30;

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
      // Keyed on the action's identity alone. affectedPools used to be part
      // of this, which meant a new signal -- and a new queued draft -- every
      // time the tip follower indexed another pool quoting that stock. The
      // count changes continuously, so the same dividend was re-queued on
      // every scan and the review queue filled with near-duplicates of one
      // event. One action is one post; the count it cites is whatever was
      // true when the draft was written.
      id: signalId('corporate_action', `${a.id}:${a.processDate}`),
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
 * The service introducing itself.
 *
 * An account's first post has to say what it is, and this one has to do it the
 * same way as every other: from facts, through the verifier, into the approval
 * queue. Writing an announcement by hand would be the one post on the feed
 * nobody could reproduce -- which is precisely the property the feed claims.
 *
 * Keyed on the rounded pool count so it does not re-queue on every scan as the
 * index grows by a few hundred pools.
 */
export function detectIntroduction(): Signal[] {
  const db = getDb();
  const n = (sql: string): number => {
    try {
      return Number((db.prepare(sql).get() as { n: number }).n);
    } catch {
      return 0;
    }
  };
  const c = computeCoverage();
  const v4 = n("SELECT COUNT(*) AS n FROM pools WHERE quote_kind = 'stock'");
  const v3 = n("SELECT COUNT(*) AS n FROM pools_v3 WHERE quote_kind = 'stock'");
  if (v4 + v3 === 0) return [];

  const totalPools = n('SELECT COUNT(*) AS n FROM pools') + n('SELECT COUNT(*) AS n FROM pools_v3');

  return [{
    id: signalId('service_intro', `${Math.round((v4 + v3) / 1000)}k`),
    kind: 'service_intro',
    severity: 'high',
    summary: `${agentIdentity.name} introduces the ${agentIdentity.service}`,
    facts: {
      name: agentIdentity.name,
      url: 'oracle.sb4s.xyz',
      stockPairedV4: v4,
      stockPairedV3: v3,
      stockPaired: v4 + v3,
      totalPools,
      stockTokens: c.total,
      tokensWithFeed: c.covered.length,
      tokensWithoutFeed: c.uncovered.length,
    },
    reproduce: 'GET /health',
    detectedAt: Date.now(),
  }];
}

/**
 * How stock-paired volume splits between Uniswap v3 and v4.
 *
 * This is the signal the project got wrong about itself. `config/addresses.ts`
 * described v3 as "a small minority of stock-paired liquidity" on no
 * measurement at all, and the indexer covered only v4 -- so a third of the
 * subject was invisible while the README claimed the pool set. Once both
 * protocols are indexed the split is a fact worth publishing, because every
 * other RH data source still reports v4 alone.
 *
 * Fires only when the smaller protocol clears PROTOCOL_SPLIT_MIN_SHARE, and is
 * keyed on the rounded share so a drifting percentage does not re-queue a post
 * that says the same thing.
 */
export async function detectProtocolSplit(): Promise<Signal[]> {
  const { buildVolumeReport } = await import('../volume/usd.js');
  const rep = await buildVolumeReport();
  if (rep.pools.length === 0 || rep.totalUsd <= 0) return [];

  let v4 = 0, v3 = 0, v4Pools = 0, v3Pools = 0;
  let top: (typeof rep.pools)[number] | null = null;
  for (const p of rep.pools) {
    if (p.volumeUsd === null) continue;
    if (p.protocol === 'v4') { v4 += p.volumeUsd; v4Pools++; } else { v3 += p.volumeUsd; v3Pools++; }
    if (!top || p.volumeUsd > (top.volumeUsd ?? 0)) top = p;
  }
  const total = v4 + v3;
  if (total <= 0 || !top) return [];

  const minorShare = Math.min(v4, v3) / total;
  if (minorShare < PROTOCOL_SPLIT_MIN_SHARE) return [];

  // Rounded to the precision a post would actually use, so the facts contain
  // exactly the numbers the text is allowed to cite and nothing has to be
  // derived at drafting time.
  const round1 = (n: number) => Number(n.toFixed(1));
  const v3Share = Math.round((v3 / total) * 100);

  return [{
    id: signalId('protocol_split', String(v3Share)),
    kind: 'protocol_split',
    severity: 'high',
    summary: `Uniswap v3 carries ${v3Share}% of stock-paired volume on Robinhood Chain`,
    facts: {
      v3SharePercent: v3Share,
      v3VolumeUsdMillions: round1(v3 / 1e6),
      v4VolumeUsdMillions: round1(v4 / 1e6),
      totalVolumeUsdMillions: round1(total / 1e6),
      windowHours: round1(rep.hours),
      v3Pools, v4Pools,
      // Largest single pool by USD volume. Note this is a different pool
      // from the largest by swap count -- which is why no published claim
      // rests on "the most-traded pool" without naming the metric.
      topPoolByUsdProtocol: top.protocol,
      topPoolByUsdSymbol: top.stockSymbol,
      topPoolByUsdMillions: round1((top.volumeUsd ?? 0) / 1e6),
      fromBlock: rep.fromBlock,
      toBlock: rep.toBlock,
    },
    reproduce: 'POST /ask {"question":"v3 v4 volume split"}',
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

  // Two conditions, both required, because "the subsidy has ended" is the
  // single claim here that would be most embarrassing to get wrong and is not
  // retractable once posted.
  //
  // A minimum sample count stops the agent speaking from a thin window, and a
  // majority stops it speaking from a blip. Both are needed: the reading is
  // known to flap -- a non-zero observation during testing reverted to zero
  // minutes later -- so any-sample-non-zero fires on noise. At 3 of 12 the
  // detector was drafting "the launch gas subsidy appears to be ending" off
  // exactly the kind of transient the /gas endpoint was built to survive.
  if (e.samples < GAS_SUBSIDY_MIN_SAMPLES) return [];
  if (e.nonZeroSamples * 2 <= e.samples) return [];

  return [{
    // Keyed on the counts, so a changed balance of evidence is a new
    // observation rather than a silent no-op against an existing post.
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
