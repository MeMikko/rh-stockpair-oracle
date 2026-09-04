import { getDb } from '../db/index.js';

/**
 * Question -> intent, deterministically.
 *
 * No model runs here. The project rule is that the data path is deterministic
 * and a model only ever phrases what the data already said; that rule has to
 * hold for answers exactly as it holds for posts, because an answer is a
 * published claim too -- it just happens to be addressed to someone.
 *
 * So intent detection is keyword matching over a closed set, and the entity is
 * matched against the indexed stock-token universe rather than extracted
 * freely. A question we cannot confidently classify returns `unknown`, and the
 * agent says it does not know. That is a feature: a wrong confident answer to
 * "what is NVDA worth" is far more damaging than no answer.
 */

export type IntentKind =
  | 'price'
  | 'pools'
  | 'corporate_action'
  | 'coverage'
  | 'gas'
  | 'protocol_split'
  | 'quote'
  | 'history'
  | 'market_drift'
  | 'large_trades'
  | 'unknown';

export interface Intent {
  kind: IntentKind;
  /** Stock symbol the question is about, when it names one. */
  symbol: string | null;
  /** v4 PoolId or v3 pool address, when the question names one. */
  poolRef: string | null;
  /** Why the classifier chose this, for the audit trail on every answer. */
  matched: string[];
}

/**
 * Keyword rules, evaluated in order. Order is the whole design here, because
 * the vocabulary genuinely overlaps and two collisions were found by testing
 * rather than reasoning:
 *
 *  - "what is the v3/v4 volume **split**" is not a stock split, so the
 *    protocol rule has to be consulted before the bare word `split`;
 *  - "how many pools **quote** NVDA" uses `quote` as a verb, so the quote rule
 *    may not fire on that word alone -- it needs a pool reference or a word
 *    that only belongs to pricing.
 *
 * Unambiguous corporate-action words still win outright: a question naming a
 * dividend is about the dividend whatever else it mentions.
 */
const RULES: Array<{ kind: IntentKind; any: RegExp[]; requires?: (i: Partial<Intent>) => boolean }> = [
  // First, and deliberately so. A question about what a pool does while the
  // market is shut names both a market word and a price word, so any later
  // rule would swallow it -- and it is the one question this service can
  // answer from a record nobody else kept. Losing it to the price rule would
  // mean answering "NVDA is $229" to "how far does NVDA drift overnight",
  // which is a confident answer to a different question.
  {
    kind: 'market_drift',
    any: [
      /\b(overnight|after hours|after-hours|premarket|pre-market)\b/i,
      /\bmarket (is )?(closed|shut|open)\b/i,
      /\b(while|when|whilst)\b.{0,20}\b(closed|shut|open)\b/i,
      /\bdrifts?\b/i,
      /\bweekend\b/i,
    ],
  },
  // Before history and before price. "What was the biggest NVDA trade" is a
  // past-tense question about a price-shaped thing, so both of those rules
  // would take it and answer something else.
  {
    kind: 'large_trades',
    any: [
      /\b(whale|whales)\b/i,
      /\b(biggest|largest|big(gest)?)\b.{0,20}\b(trade|trades|swap|swaps|buy|sell|order)\b/i,
      /\b(trade|trades|swap|swaps)\b.{0,20}\b(today|recent|lately|big)\b/i,
      /\bany (big|large|notable)\b/i,
    ],
  },
  // Then history, before price: "what was NVDA" and "what is NVDA" differ by
  // one word and by which table holds the answer.
  {
    kind: 'history',
    any: [
      /\b(history|historical|over time|time series|timeseries)\b/i,
      /\b(yesterday|last (week|night|hour|day)|past (week|day|hours?|days?))\b/i,
      /\bwhat (was|were|did)\b/i,
      /\b(has|have) .{0,30}\b(been|changed|moved)\b/i,
      /\btrend(ed|ing)?\b/i,
    ],
  },
  {
    kind: 'corporate_action',
    any: [
      /\b(dividend|corporate action|ticker change|reprice[sd]?)\b/i,
      /\bnext\s+(action|event)\b/i,
      /\bex[- ]?date\b/i,
    ],
  },
  {
    kind: 'protocol_split',
    any: [/\bv[34]\b/i, /\bprotocol split\b/i, /\bvolume\b/i, /\bmarket share\b/i],
  },
  // Only reached when the question is not about protocol share, so a bare
  // "split" here means the corporate action.
  { kind: 'corporate_action', any: [/\b(reverse |forward |stock |share )?split\b/i] },
  { kind: 'gas', any: [/\bgas\b/i, /\bsubsid(y|ies|ised|ized)\b/i, /\bL1 (data|cost)\b/i] },
  {
    kind: 'coverage',
    any: [/\bcoverage\b/i, /\bchainlink\b/i, /\bfeeds?\b/i, /\boracle\b/i, /\bdeviation\b/i],
  },
  // Before `pools`, and before the bare-symbol fallback below. "what is TSLA
  // price" matched no keyword at all and fell through to a pool count -- a
  // confident wrong answer to the most obvious question anyone asks, which is
  // the failure this classifier exists to avoid.
  //
  // "price impact" is excluded: that belongs to a specific pool and routes to
  // the quote rule instead.
  {
    kind: 'price',
    any: [
      /\bprice\b(?!\s+impact)/i,
      /\bworth\b/i,
      /\btrading at\b/i,
      /\bhow much\b/i,
      /\bcost(s|ing)?\b/i,
    ],
  },
  { kind: 'pools', any: [/\bpools?\b/i, /\bhow many\b/i, /\bpaired\b/i, /\bindexed\b/i] },
  {
    kind: 'quote',
    any: [/\bquote\b/i, /\bprice impact\b/i, /\bdepth\b/i, /\bslippage\b/i],
    // `quote` is a verb in "pools quote NVDA"; a quote request names a pool.
    requires: (i) => Boolean(i.poolRef),
  },
  { kind: 'quote', any: [/\bprice impact\b/i, /\bdepth\b/i, /\bslippage\b/i] },
];

/** 0x-prefixed 32-byte PoolId or 20-byte pool address. */
const POOL_REF = /\b0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\b/;

let symbolCache: Set<string> | null = null;

/**
 * Known stock symbols, from the indexed universe rather than a hardcoded list,
 * so a newly listed ticker is answerable the moment the registry syncs.
 */
export function knownSymbols(): Set<string> {
  if (symbolCache) return symbolCache;
  const rows = getDb().prepare('SELECT symbol FROM stock_tokens').all() as unknown as Array<{
    symbol: string;
  }>;
  symbolCache = new Set(rows.map((r) => r.symbol.toUpperCase()));
  return symbolCache;
}

/** Test seam; also lets a long-running listener pick up a registry sync. */
export function resetSymbolCache(): void {
  symbolCache = null;
}

/**
 * Find a stock symbol in free text.
 *
 * Matched only as a whole uppercase word against the known universe. Lowercase
 * is deliberately not accepted: "on" and "pr" are real tickers on this chain,
 * and matching them case-insensitively would turn ordinary English into a
 * ticker lookup on almost every question.
 */
export function findSymbol(text: string, known = knownSymbols()): string | null {
  const words = text.match(/\b[A-Z][A-Z0-9.]{0,6}\b/g) ?? [];
  for (const w of words) {
    if (known.has(w)) return w;
  }
  return null;
}

export function classify(text: string): Intent {
  const matched: string[] = [];
  const poolRef = text.match(POOL_REF)?.[0] ?? null;
  const symbol = findSymbol(text);

  for (const rule of RULES) {
    if (rule.requires && !rule.requires({ symbol, poolRef })) continue;
    for (const re of rule.any) {
      if (re.test(text)) {
        matched.push(`${rule.kind}:${re.source.slice(0, 32)}`);
        return { kind: rule.kind, symbol, poolRef, matched };
      }
    }
  }

  // A bare pool reference with no other cue is a quote request; a bare symbol
  // is a question about its pools. Anything else is not understood.
  if (poolRef) return { kind: 'quote', symbol, poolRef, matched: ['fallback:poolRef'] };
  if (symbol) return { kind: 'pools', symbol, poolRef, matched: ['fallback:symbol'] };
  return { kind: 'unknown', symbol: null, poolRef: null, matched };
}
