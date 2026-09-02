/**
 * Guard rail between the model and a public timeline.
 *
 * The project rule is that every posted claim be reproducible from an endpoint
 * response. The data path is deterministic, but the phrasing is not, so a draft
 * is only allowed to contain numbers that already appear in the signal's facts.
 * A model that invents a percentage, rounds a rate, or embellishes a pool count
 * fails this check and its draft is discarded rather than queued.
 */

export interface VerificationResult {
  ok: boolean;
  /** Numeric tokens in the draft with no counterpart in the facts. */
  unsupported: string[];
  allowed: string[];
  tooLong: boolean;
  length: number;
}

/** Longest safe length across the target channels (X is the tighter one). */
export const MAX_POST_LENGTH = 280;

const normalise = (s: string) => s.replace(/,/g, '').replace(/^0+(?=\d)/, '').replace(/\.0+$/, '');

/** Every numeric form a draft may legitimately use, derived from the facts. */
export function allowedNumbers(facts: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (raw: string) => {
    const n = normalise(raw);
    if (n.length > 0) out.add(n);
  };

  for (const value of Object.values(facts)) {
    if (value === null || value === undefined) continue;
    const s = String(value);
    add(s);
    // Numbers embedded in strings: rates like "0.252886", dates like
    // "2026-09-03" (a post may write the month or day on its own).
    for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) add(m[0]);
    if (typeof value === 'number') {
      add(value.toFixed(0));
      if (!Number.isInteger(value)) add(value.toFixed(1));
      add(String(Math.round(value)));
    }
  }
  return out;
}

/**
 * Digits that name a thing rather than measure one.
 *
 * "ERC-8056", "chain 4663" and "Uniswap v4" are identifiers: they carry no
 * claim about the data and cannot be wrong in the way an invented percentage
 * can. They are removed before the numeric check so that naming the standard a
 * post is describing does not fail verification. Nothing here admits a
 * free-standing number -- each pattern requires its identifying prefix.
 */
const IDENTIFIER_PATTERNS: RegExp[] = [
  /\b(?:ERC|EIP|BEP)-\d+\b/gi,
  /\bv[2-4]\b/gi,
  /\bchain(?:\s+id)?\s+4663\b/gi,
  /\bRobinhood\s+Chain\b/gi,
  // "L1" and "L2" name the layer, not a quantity. Without this the gas
  // template's "charging for L1 data" contributed a bare 1 to the numeric
  // scan: it passed only while nonZeroSamples happened to equal 1, and began
  // failing verification the moment that count moved.
  /\bL[12]\b/gi,
];

function stripIdentifiers(text: string): string {
  return IDENTIFIER_PATTERNS.reduce((s, re) => s.replace(re, ' '), text);
}

export function verifyDraft(text: string, facts: Record<string, unknown>): VerificationResult {
  const allowed = allowedNumbers(facts);
  const unsupported: string[] = [];

  for (const m of stripIdentifiers(text).matchAll(/\d+(?:[.,]\d+)*/g)) {
    const token = normalise(m[0]);
    if (!allowed.has(token)) unsupported.push(m[0]);
  }

  return {
    ok: unsupported.length === 0 && text.length <= MAX_POST_LENGTH && text.trim().length > 0,
    unsupported,
    allowed: [...allowed],
    tooLong: text.length > MAX_POST_LENGTH,
    length: text.length,
  };
}
