import { getDb } from '../db/index.js';
import { classify, type Intent } from './intent.js';
import { computeCoverage } from '../registry/coverage.js';
import { upcomingActions } from '../corporate/calendar.js';
import { readGas } from '../pricing/gas.js';
import { feedFor } from '../registry/feeds.js';
import { readFeed } from '../pricing/chainlink.js';
import { marketStatus } from '../pricing/marketHours.js';
import { verifyDraft } from '../agent/verify.js';
import { REPRODUCE } from '../api/routes/data.js';
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

const NO_IDEA =
  'I only answer from indexed Robinhood Chain data: stock prices from Chainlink, pool ' +
  'counts, upcoming corporate actions, feed coverage, gas, and the v3/v4 volume split. ' +
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

    case 'gas': {
      const g = await readGas();
      const e = g.subsidy.evidence;
      return {
        ...base,
        facts: {
          samples: e.samples,
          nonZeroSamples: e.nonZeroSamples,
          freeAcrossWindow: e.freeAcrossWindow,
          perL1CalldataUnit: g.perL1CalldataUnit,
          baseFeePerGas: g.baseFeePerGas,
        },
        text: e.freeAcrossWindow
          ? `L1 calldata is charged at zero across all ${e.samples} retained samples: the launch subsidy is still active. Costs are L2-only and will rise when it ends.`
          : `L1 calldata is non-zero in ${e.nonZeroSamples} of ${e.samples} retained samples. The reading flaps, so treat the subsidy as uncertain rather than ended.`,
        reproduce: 'GET /gas',
      };
    }

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
