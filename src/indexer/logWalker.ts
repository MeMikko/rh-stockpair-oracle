import { getCursor, setCursor } from '../db/index.js';

/**
 * Adaptive eth_getLogs range walker, shared by every log-backed stream.
 *
 * Two different endpoints impose two different limits and the walker has to
 * satisfy both without being told which it is talking to:
 *
 *  - the public RH endpoint rejects ranges over ~1000 blocks and also times
 *    out server-side on ranges it nominally accepts;
 *  - dedicated endpoints (Alchemy) accept an unbounded range but cap the
 *    *response* at 10,000 logs.
 *
 * So the span is a moving target in both directions: halve on failure down to
 * MIN_SPAN, grow back on clean responses, and additionally hold the span down
 * whenever a range comes back near the result cap. Growing back matters --
 * chain 4663 is past 52M blocks, and a fixed 1000-block span would need 52,000
 * round trips to walk it once.
 */

const MIN_SPAN = 25n;
/** Treat a response at or above this as "the cap truncated me". */
const RESULT_CAP = 9_500;

/** Errors that mean "your range was too wide", not "the node is broken". */
export function isRangeError(err: unknown): boolean {
  const m = (err as Error)?.message?.toLowerCase() ?? '';
  return (
    m.includes('capped at') ||
    m.includes('narrow the range') ||
    m.includes('range too wide') ||
    m.includes('more than 10000') ||
    m.includes('10000 results') ||
    m.includes('query returned more than') ||
    m.includes('response size') ||
    m.includes('block range') ||
    m.includes('range is too large') ||
    m.includes('limit exceeded') ||
    m.includes('context deadline') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('too many') ||
    m.includes('429')
  );
}

export interface WalkOpts<T> {
  stream: string;
  fromBlock: bigint;
  toBlock: bigint;
  maxSpan: bigint;
  /** Fetch one range. Must throw on failure; the walker owns retry/backoff. */
  fetch: (from: bigint, to: bigint) => Promise<T[]>;
  /** Persist one range's rows. Runs before the cursor is committed. */
  save: (rows: T[], from: bigint, to: bigint) => void;
  /** Resume from a stored cursor rather than fromBlock. Default true. */
  resume?: boolean;
  onProgress?: (info: Progress) => void;
  /** Stop after this many committed ranges. */
  maxRanges?: number;
}

export interface Progress {
  from: bigint;
  to: bigint;
  rows: number;
  span: bigint;
  /** Fraction of the requested window committed so far, 0..1. */
  done: number;
  ranges: number;
  failures: number;
}

export interface WalkResult {
  ranges: number;
  rows: number;
  failures: number;
  /** Last block committed; equals toBlock on a complete walk. */
  cursor: bigint;
  complete: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function walkLogs<T>(opts: WalkOpts<T>): Promise<WalkResult> {
  const { stream, toBlock, maxSpan } = opts;
  const stored = opts.resume === false ? null : getCursor(stream);
  let cursor =
    stored !== null && BigInt(stored) + 1n > opts.fromBlock ? BigInt(stored) + 1n : opts.fromBlock;

  const start = cursor;
  const total = toBlock >= start ? toBlock - start + 1n : 1n;
  let span = maxSpan;
  let ranges = 0, rows = 0, failures = 0, consecutiveOk = 0;

  while (cursor <= toBlock) {
    if (opts.maxRanges !== undefined && ranges >= opts.maxRanges) break;
    const to = cursor + span - 1n > toBlock ? toBlock : cursor + span - 1n;

    try {
      const got = await opts.fetch(cursor, to);

      // A response at the cap is indistinguishable from a truncated one, so
      // treat it as a range error rather than silently losing logs.
      if (got.length >= RESULT_CAP && span > MIN_SPAN) {
        span = span / 4n < MIN_SPAN ? MIN_SPAN : span / 4n;
        consecutiveOk = 0;
        continue;
      }

      opts.save(got, cursor, to);
      setCursor(stream, Number(to));
      rows += got.length;
      ranges++;
      cursor = to + 1n;
      opts.onProgress?.({
        from: cursor - span, to, rows: got.length, span,
        done: Number(((to - start + 1n) * 1000n) / total) / 1000,
        ranges, failures,
      });

      // Grow back toward the cap, but only while responses stay small: a
      // stream that is dense here is probably dense in the next range too.
      if (++consecutiveOk >= 2 && span < maxSpan && got.length < RESULT_CAP / 4) {
        span = span * 2n > maxSpan ? maxSpan : span * 2n;
        consecutiveOk = 0;
      }
    } catch (err) {
      failures++;
      consecutiveOk = 0;
      if (span > MIN_SPAN && isRangeError(err)) {
        span = span / 4n < MIN_SPAN ? MIN_SPAN : span / 4n;
        await sleep(300);
        continue;
      }
      if (span > MIN_SPAN) {
        span = span / 2n < MIN_SPAN ? MIN_SPAN : span / 2n;
        await sleep(1_000);
        continue;
      }
      if (failures % 5 === 0) {
        console.error(
          `[${stream}] stuck at ${cursor} after ${failures} failures: ` +
            `${(err as Error).message.slice(0, 140)}`,
        );
      }
      if (failures > 200) {
        return { ranges, rows, failures, cursor: cursor - 1n, complete: false };
      }
      await sleep(5_000);
    }
  }

  return { ranges, rows, failures, cursor: cursor - 1n, complete: cursor > toBlock };
}
