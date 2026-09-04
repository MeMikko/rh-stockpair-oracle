import { getDb } from '../db/index.js';
import { classify, type Intent } from './intent.js';
import { computeCoverage } from '../registry/coverage.js';
import { upcomingActions } from '../corporate/calendar.js';
import { readGas, type GasSnapshot } from '../pricing/gas.js';
import { feedFor } from '../registry/feeds.js';
import { readFeed } from '../pricing/chainlink.js';
import { marketStatus } from '../pricing/marketHours.js';
import { verifyDraft } from '../agent/verify.js';
import { REPRODUCE } from '../api/routes/data.js';
import { bestSampledPool, driftBySession, historyDepth, snapshotsForPool } from '../history/series.js';
import { aboutFacts, conversationalAnswer, conversationalConfig } from './conversational.js';
import type { Tier } from '../entitlements/index.js';

/**
 * Deterministic answers to questions about the indexed data.
 *
 * Same contract as a post: the text may only contain numbers that appear in
 * `facts`, and `reproduce` names the endpoint call that reproduces it. An
 * answer is a published claim like any other, so it goes through the same
 * verifier -- that is what makes "every claim is reproducible" true of the
 * conversational surface too, not just the feed.
 *
 * When the question is not understood, the answer says so. There is no
 * fallback that guesses.
 */

export interface Answer {
  intent: Intent;
  /** Every number the text is allowed to cite. */
  facts: Record<string, string | number | boolean | null>;
  text: string;
  reproduce: string;
  /** False when the question could not be classified or the data is absent. */
  answered: boolean;
  /**
   * True when a model wrote the reply on the fallback path.
   *
   * Separate from `answered` because they mean different things and a caller
   * needs both: nothing was looked up (so this is not a measurement), but
   * there is still something worth saying (so silence would be wrong).
   */
  conversational?: boolean;
}

/** Two decimals, because that is the precision the text quotes. A number the
 * text renders differently from the fact it came from fails the verifier. */
const round2 = (n: number) => Number(n.toFixed(2));

const NO_IDEA =
  'I only answer from indexed Robinhood Chain data: stock prices from Chainlink, pool ' +
  'counts, upcoming corporate actions, feed coverage, gas, the v3/v4 volume split, and ' +
  'what I have recorded over time — including how far pools drift while the market is shut. ' +
  'Name a ticker or a pool id.';

function poolCounts(symbol: string): { v4: number; v3: number; total: number } {
  const db = getDb();
  const v4 = (
    db.prepare('SELECT COUNT(*) c FROM pools WHERE stock_symbol = ?').get(symbol) as unknown as {
      c: number;
    }
  ).c;
  const v3 = (
    db.prepare('SELECT COUNT(*) c FROM pools_v3 WHERE stock_symbol = ?').get(symbol) as unknown as {
      c: number;
    }
  ).c;
  return { v4, v3, total: v4 + v3 };
}

async function build(intent: Intent, now = new Date()): Promise<Answer> {
  const base = { intent, answered: true as boolean };

  switch (intent.kind) {
    case 'price': {
      // The stock's own USD price, from its Chainlink feed. This is a chain
      // read, not an index lookup, and it is the answer to the most common
      // question there is -- which until now fell through to a pool count.
      if (!intent.symbol) break;
      const feed = feedFor(intent.symbol);
      if (!feed) {
        // Refusing here is the point. 159 of 194 tokens have no feed, and a
        // pool's implied price is not the stock's price: it is whatever the
        // other side of that pool is worth.
        return {
          ...base,
          facts: { symbol: intent.symbol },
          text:
            `${intent.symbol} has no Chainlink feed on Robinhood Chain, so there is no ` +
            `oracle price for it. A pool quoting ${intent.symbol} implies a price for the ` +
            `token paired against it, not for ${intent.symbol} itself.`,
          reproduce: 'GET /coverage',
        };
      }

      const market = marketStatus(now);
      try {
        const read = await readFeed(feed);
        return {
          ...base,
          facts: {
            symbol: intent.symbol,
            priceUsd: read.priceUsd,
            ageSeconds: read.ageSeconds,
            stale: read.stale,
            marketOpen: market.isOpen,
            session: market.session,
          },
          text:
            `${intent.symbol} is $${read.priceUsd} per the Chainlink feed on Robinhood Chain, ` +
            `updated ${read.ageSeconds}s ago. The underlying market is ${market.session}` +
            `${market.isOpen ? '' : ', so on-chain pools can drift from this'}.`,
          reproduce: REPRODUCE.price(intent.symbol),
        };
      } catch {
        return {
          ...base,
          facts: { symbol: intent.symbol },
          text: `The Chainlink feed for ${intent.symbol} could not be read just now.`,
          reproduce: REPRODUCE.price(intent.symbol),
          answered: false,
        };
      }
    }

    case 'pools': {
      if (!intent.symbol) break;
      const c = poolCounts(intent.symbol);
      if (c.total === 0) {
        return {
          ...base,
          facts: { symbol: intent.symbol, total: 0 },
          text: `No indexed pool on Robinhood Chain quotes ${intent.symbol}.`,
          reproduce: REPRODUCE.pools(intent.symbol),
        };
      }
      return {
        ...base,
        facts: { symbol: intent.symbol, v4Pools: c.v4, v3Pools: c.v3, totalPools: c.total },
        text:
          `${c.total} indexed pools on Robinhood Chain quote ${intent.symbol} ` +
          `(${c.v4} on Uniswap v4, ${c.v3} on v3).`,
        reproduce: REPRODUCE.pools(intent.symbol),
      };
    }

    case 'corporate_action': {
      const actions = upcomingActions(30, now).filter((a) => a.status !== 'COMPLETED');
      const next = intent.symbol
        ? actions.find((a) => a.tokenSymbol === intent.symbol)
        : actions[0];
      if (!next) {
        const scope = intent.symbol ? ` for ${intent.symbol}` : '';
        return {
          ...base,
          facts: { symbol: intent.symbol, withinDays: 30, found: 0 },
          text: `No corporate action${scope} in the next 30 days touches an indexed pool.`,
          reproduce: 'GET /corporate-actions?withinDays=30',
        };
      }
      return {
        ...base,
        facts: {
          symbol: next.tokenSymbol,
          actionType: next.type,
          processDate: next.processDate,
          daysAway: next.daysAway,
          affectedPools: next.affectedPools,
          rate: (next.detail.rate as string) ?? null,
        },
        text:
          `${next.tokenSymbol}: ${next.type.toLowerCase().replace(/_/g, ' ')} processes ` +
          `${next.processDate}. On Robinhood Chain it lands as an ERC-8056 multiplier change, ` +
          `repricing ${next.affectedPools} indexed pool(s) quoted in ${next.tokenSymbol}.`,
        reproduce: 'GET /corporate-actions?withinDays=30',
      };
    }

    case 'coverage': {
      const c = computeCoverage();
      if (c.total === 0) break;
      // A per-symbol coverage question deserves a per-symbol answer.
      if (intent.symbol) {
        const covered = c.covered.includes(intent.symbol);
        return {
          ...base,
          facts: { symbol: intent.symbol, covered, total: c.total, withFeed: c.covered.length },
          text: covered
            ? `${intent.symbol} has a Chainlink feed on Robinhood Chain, so a pool's deviation from the underlying price is computable.`
            : `${intent.symbol} has no Chainlink feed on Robinhood Chain. Its deviation from the underlying is not merely unknown, it is unknowable on-chain.`,
          reproduce: 'GET /coverage',
        };
      }
      return {
        ...base,
        facts: {
          total: c.total,
          covered: c.covered.length,
          uncovered: c.uncovered.length,
          coveragePercent: Number((c.coverageRatio * 100).toFixed(1)),
        },
        text:
          `${c.uncovered.length} of ${c.total} Robinhood Chain stock tokens have no Chainlink ` +
          `feed (${Number((c.coverageRatio * 100).toFixed(1))}% covered).`,
        reproduce: 'GET /coverage',
      };
    }

    /**
     * What a pool did, rather than what it is doing.
     *
     * The only answer here that can be wrong by being *empty* rather than by
     * being incorrect, and the difference matters: "I have not been recording
     * long enough" is a true statement about this deployment, where "I do not
     * know" would imply the question is unanswerable. So a thin series says
     * how thin it is instead of pretending, and never extrapolates from two
     * points.
     */
    case 'history': {
      if (!intent.symbol) break;
      const hours = 24;
      const depth = historyDepth();
      const best = bestSampledPool(intent.symbol);
      if (!best) {
        return {
          ...base,
          facts: { symbol: intent.symbol, samples: 0, snapshots: depth.snapshots },
          text:
            `I have no recorded history for ${intent.symbol} yet. Sampling covers the busiest ` +
            'stock-paired pools first, so a quiet pool takes longer to appear.',
          reproduce: REPRODUCE.history(intent.symbol, hours),
          answered: false,
        };
      }
      const series = snapshotsForPool(best.poolKey, Date.now() - hours * 3_600_000);
      // Flagged samples are left out of the range and the change: a price set
      // by one order large enough to move the pool 10% would set the high or
      // the low on its own and describe that order rather than the day.
      const priced = series.filter((r) => r.poolStockUsd !== null && r.priceFlag === null);
      if (priced.length < 2) {
        return {
          ...base,
          facts: { symbol: intent.symbol, samples: priced.length, hours },
          text:
            `I have ${priced.length} priced samples for ${intent.symbol} in the last ${hours} ` +
            'hours — not enough to say what it did. Ask again once more has been recorded.',
          reproduce: REPRODUCE.history(intent.symbol, hours),
          answered: false,
        };
      }
      const first = priced[0]!.poolStockUsd!;
      const last = priced[priced.length - 1]!.poolStockUsd!;
      const values = priced.map((r) => r.poolStockUsd!);
      const low = round2(Math.min(...values));
      const high = round2(Math.max(...values));
      const changePercent = round2(((last - first) / first) * 100);
      return {
        ...base,
        facts: {
          symbol: intent.symbol,
          samples: priced.length,
          hours,
          first: round2(first),
          last: round2(last),
          low,
          high,
          changePercent,
        },
        text:
          `Over the last ${hours} hours the busiest ${intent.symbol} pool implied ` +
          `${round2(first)} to ${round2(last)} USD, ranging ${low} to ${high} ` +
          `(${changePercent}% across ${priced.length} recorded samples).`,
        reproduce: REPRODUCE.history(intent.symbol, hours),
      };
    }

    /**
     * The question this whole service exists to be able to answer.
     *
     * Stock tokens trade 24/5 on-chain while the equity market keeps hours, so
     * whether a pool drifts while the market is shut is measurable — but only
     * against a record that pairs each price with the session it was taken in.
     * Nothing else on this chain kept one, which is also why the honest answer
     * on a young deployment is that the record is still short.
     */
    case 'market_drift': {
      if (!intent.symbol) break;
      const hours = 24 * 7;
      const stats = driftBySession(intent.symbol, Date.now() - hours * 3_600_000);
      const open = stats.find((s) => s.session === 'regular');
      const shut = stats.find((s) => s.session === 'closed');
      if (!open?.meanAbsDeviation || !shut?.meanAbsDeviation) {
        const have = stats.reduce((n, s) => n + s.samples, 0);
        return {
          ...base,
          facts: { symbol: intent.symbol, samples: have, hours },
          text:
            `I cannot compare open and closed sessions for ${intent.symbol} yet: ${have} ` +
            'recorded samples, and both sides of the comparison need measured deviations. ' +
            'A stock with no Chainlink feed never gets them at all.',
          reproduce: REPRODUCE.history(intent.symbol, hours),
          answered: false,
        };
      }
      const openPct = round2(open.meanAbsDeviation * 100);
      const shutPct = round2(shut.meanAbsDeviation * 100);
      return {
        ...base,
        facts: {
          symbol: intent.symbol,
          hours,
          openMeanPercent: openPct,
          closedMeanPercent: shutPct,
          openSamples: open.usable,
          closedSamples: shut.usable,
        },
        text:
          `Over ${hours} hours, ${intent.symbol} pools sat ${openPct}% from the Chainlink ` +
          `price on average while the market was open and ${shutPct}% while it was closed ` +
          `(${open.usable} and ${shut.usable} usable samples).`,
        reproduce: REPRODUCE.history(intent.symbol, hours),
      };
    }

    case 'gas':
      return { ...base, ...gasAnswer(await readGas()) };

    case 'protocol_split': {
      const { buildVolumeReport } = await import('../volume/usd.js');
      const rep = await buildVolumeReport();
      if (rep.pools.length === 0) break;
      let v4 = 0, v3 = 0;
      for (const p of rep.pools) {
        if (p.volumeUsd === null) continue;
        if (p.protocol === 'v4') v4 += p.volumeUsd; else v3 += p.volumeUsd;
      }
      const total = v4 + v3;
      if (total <= 0) break;
      const r1 = (n: number) => Number(n.toFixed(1));
      return {
        ...base,
        facts: {
          v3SharePercent: Math.round((v3 / total) * 100),
          v3VolumeUsdMillions: r1(v3 / 1e6),
          v4VolumeUsdMillions: r1(v4 / 1e6),
          totalVolumeUsdMillions: r1(total / 1e6),
          windowHours: r1(rep.hours),
        },
        text:
          `Over the last ${r1(rep.hours)}h, stock-paired volume on Robinhood Chain was ` +
          `$${r1(total / 1e6)}M: $${r1(v4 / 1e6)}M on Uniswap v4 and $${r1(v3 / 1e6)}M on v3 ` +
          `(${Math.round((v3 / total) * 100)}%).`,
        // Was `POST /ask` with the same question -- circular, and flagged as
        // such by an external test. A reproduce field has to name a different
        // route that shows the same number independently.
        reproduce: REPRODUCE.volume(),
      };
    }

    case 'quote': {
      // Quotes are live state, not cached data. Rather than half-answer from
      // the index, point at the endpoint that reads the chain.
      if (!intent.poolRef) break;
      return {
        ...base,
        facts: { poolRef: intent.poolRef },
        text:
          `Live pricing for that pool is a chain read, not an index lookup. ` +
          `GET /quote?pool=${intent.poolRef} returns spot, depth, price impact and ` +
          `Chainlink deviation.`,
        reproduce: `GET /quote?pool=${intent.poolRef}`,
      };
    }

    default:
      break;
  }

  return {
    intent,
    facts: {},
    text: NO_IDEA,
    reproduce: 'GET /coverage',
    answered: false,
  };
}

/**
 * Answer a free-text question.
 *
 * The returned text is verified against its own facts before it leaves this
 * function. A template that drifts into citing a number it did not put in
 * `facts` fails here rather than in front of an audience.
 */
/**
 * The `/ask` answer about gas, split out from the network read so it can be
 * exercised against a synthetic snapshot.
 *
 * Three states, not two. A non-zero count on its own is ambiguous between a
 * subsidy that has lapsed and a reading that flaps, and the run in progress is
 * what separates them -- so the answer says which one the samples actually
 * support rather than hedging across both.
 */
export function gasAnswer(g: GasSnapshot): Pick<Answer, 'facts' | 'text' | 'reproduce'> {
  const e = g.subsidy.evidence;
  // The text quotes minutes, so minutes must be a fact. Derived at render time
  // it was a number the facts did not carry, and the verifier -- doing exactly
  // its job -- refused the whole answer rather than just the digit.
  const runMinutes = Math.round(e.currentNonZeroRunSeconds / 60);
  return {
    facts: {
      samples: e.samples,
      nonZeroSamples: e.nonZeroSamples,
      currentNonZeroRun: e.currentNonZeroRun,
      currentNonZeroRunSeconds: e.currentNonZeroRunSeconds,
      currentNonZeroRunMinutes: runMinutes,
      freeAcrossWindow: e.freeAcrossWindow,
      perL1CalldataUnit: g.perL1CalldataUnit,
      baseFeePerGas: g.baseFeePerGas,
    },
    text: e.freeAcrossWindow
      ? `L1 calldata is charged at zero across all ${e.samples} retained samples: the launch subsidy is still active. Costs are L2-only and will rise when it ends.`
      : e.currentNonZeroRun === 0
        ? `L1 calldata is free right now, but was non-zero in ${e.nonZeroSamples} of ${e.samples} retained samples. The reading flaps, so treat the subsidy as uncertain rather than ended.`
        : `L1 calldata has been charged in the last ${e.currentNonZeroRun} consecutive samples, spanning ${runMinutes} minutes, with none free in between (${e.nonZeroSamples} of ${e.samples} retained samples non-zero). That is what the end of the subsidy looks like; short runs have reverted before.`,
    reproduce: 'GET /gas',
  };
}

export async function answerQuestion(
  question: string,
  now = new Date(),
  opts: { tier?: Tier } = {},
): Promise<Answer> {
  const answer = await build(classify(question), now);
  const v = verifyDraft(answer.text, answer.facts);
  if (!v.ok && answer.answered) {
    // Never emit an unverifiable answer. Degrade to the honest non-answer and
    // make the failure loud, because this can only be a bug in a template.
    console.error(
      `[answer] template for '${answer.intent.kind}' cited unsupported numbers ` +
        `${v.unsupported.join(', ')}; refusing to answer`,
    );
    return { ...answer, text: NO_IDEA, answered: false };
  }
  // Only where the deterministic path gave up. A question it can route keeps
  // its template answer -- putting a model in front of a working lookup adds
  // a failure mode and buys nothing.
  if (!answer.answered) {
    const allowed =
      conversationalConfig.mode === 'all' ||
      (conversationalConfig.mode === 'pro' && opts.tier === 'pro');
    if (allowed) {
      const c = await conversationalAnswer(question, answer.text);
      if (c.usedModel) {
        return {
          ...answer,
          text: c.text,
          facts: aboutFacts(),
          reproduce: 'GET /health',
          // Still false: nothing was looked up. The reply explains the
          // service rather than answering a data question, and a caller
          // should not treat it as a measurement. `conversational` is what
          // tells the reply path there is something worth saying anyway.
          answered: false,
          conversational: true,
        };
      }
      if (c.rejected) {
        // Never log an empty reason: a rejection with nothing after the colon
        // is how this bug hid, saying a reply had been discarded and not why.
        console.error(
          `[answer] conversational reply rejected: ${c.rejected.join(', ') || 'no reason recorded'}`,
        );
      }
    }
  }

  return answer;
}
