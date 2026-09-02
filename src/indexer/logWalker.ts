import { getCursor, setCursor } from '../db/index.js';

/**
 * Adaptive eth_getLogs range walker, shared by every log-backed stream.
 *
 * Every endpoint here imposes a different limit and the walker has to satisfy
 * all of them without being told which one it is talking to. Measured
 * 2026-09-02:
 *
 *  - the public RH endpoint has no block-range cap but truncates a response
 *    near 10,000 logs, and returns "Too Many Requests" under load;
 *  - Alchemy's free tier caps the *range* at 10 blocks, hard;
 *  - Blockscout caps a response at 1000 rows and allows ~10 requests/window.
 *
 * So the span is a moving target in both directions: shrink on failure down to
 * MIN_SPAN, grow back on clean responses, and hold it down whenever a range
 * comes back near the result cap. Growing back is what makes the walk viable --
 * chain 4663 is past 52M blocks, and a fixed 1000-block span would need 52,000
 * round trips where a 200,000-block span needs 262.
 */

const MIN_SPAN = 25n;
/** Treat a response at or above this as "the cap truncated me". */
const RESULT_CAP = 9_500;

/**
 * Errors no amount of narrowing or waiting will fix inside one run. A rate
 * limit measured in requests-per-window is not a range problem: shrinking the
 * span makes it strictly worse by requiring more requests, and the walker's
 * backoff just spends the next window's budget. Abort and say so.
 */
export function isFatalError(err: unknown): boolean {
  const m = (err as Error)?.message?.toLowerCase() ?? '';
  return m.includes('rate limited') || m.includes('requests per window');
}

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
  /**
   * Ranges fetched in parallel. The cursor still advances contiguously: a
   * batch commits only its leading run of successes, so an interrupted walk
   * never leaves a hole behind a committed cursor.
   */
  concurrency?: number;
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
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  let span = maxSpan;
  let ranges = 0, rows = 0, failures = 0, consecutiveOk = 0;
  /** Consecutive failures at the current position, for the give-up check. */
  let stuck = 0;

  type Outcome =
    | { ok: true; from: bigint; to: bigint; got: T[] }
    | { ok: false; from: bigint; to: bigint; err: unknown; capped: boolean };

  while (cursor <= toBlock) {
    if (opts.maxRanges !== undefined && ranges >= opts.maxRanges) break;

    // Lay out a contiguous batch. Ordering matters more than parallelism
    // here: results are committed strictly in order so the cursor is always
    // a block below which everything has been seen.
    const batch: Array<{ from: bigint; to: bigint }> = [];
    let next = cursor;
    for (let i = 0; i < concurrency && next <= toBlock; i++) {
      const to = next + span - 1n > toBlock ? toBlock : next + span - 1n;
      batch.push({ from: next, to });
      next = to + 1n;
      if (opts.maxRanges !== undefined && ranges + batch.length >= opts.maxRanges) break;
    }

    const results: Outcome[] = await Promise.all(
      batch.map(async ({ from, to }): Promise<Outcome> => {
        try {
          const got = await opts.fetch(from, to);
          // A response at the cap is indistinguishable from a truncated one,
          // so treat it as a range error rather than silently losing logs.
          if (got.length >= RESULT_CAP) return { ok: false, from, to, err: null, capped: true };
          return { ok: true, from, to, got };
        } catch (err) {
          return { ok: false, from, to, err, capped: false };
        }
      }),
    );

    // Commit the leading run of successes, then deal with the first failure.
    let committed = 0;
    for (const r of results) {
      if (!r.ok) break;
      opts.save(r.got, r.from, r.to);
      setCursor(stream, Number(r.to));
      rows += r.got.length;
      ranges++;
      committed++;
      cursor = r.to + 1n;
      opts.onProgress?.({
        from: r.from, to: r.to, rows: r.got.length, span,
        done: Number(((r.to - start + 1n) * 1000n) / total) / 1000,
        ranges, failures,
      });
    }

    const firstFailure = results[committed];
    if (!firstFailure || firstFailure.ok) {
      // Whole batch clean. Grow back toward the cap, but only while responses
      // stay small: a stream dense here is probably dense in the next range.
      stuck = 0;
      const densest = Math.max(0, ...results.map((r) => (r.ok ? r.got.length : 0)));
      if (++consecutiveOk >= 2 && span < maxSpan && densest < RESULT_CAP / 4) {
        span = span * 2n > maxSpan ? maxSpan : span * 2n;
        consecutiveOk = 0;
      }
      continue;
    }

    failures++;
    stuck = committed > 0 ? 0 : stuck + 1;
    consecutiveOk = 0;

    if (isFatalError(firstFailure.err)) {
      console.error(
        `[${stream}] aborting at ${cursor}: ${(firstFailure.err as Error).message.slice(0, 160)}`,
      );
      return { ranges, rows, failures, cursor: cursor - 1n, complete: false };
    }

    if (span > MIN_SPAN && (firstFailure.capped || isRangeError(firstFailure.err))) {
      span = span / 4n < MIN_SPAN ? MIN_SPAN : span / 4n;
      await sleep(300);
      continue;
    }
    if (span > MIN_SPAN) {
      span = span / 2n < MIN_SPAN ? MIN_SPAN : span / 2n;
      await sleep(1_000);
      continue;
    }
    if (stuck % 5 === 0) {
      console.error(
        `[${stream}] stuck at ${cursor} after ${stuck} failed attempts: ` +
          `${(firstFailure.err as Error)?.message?.slice(0, 140) ?? 'result cap at minimum span'}`,
      );
    }
    if (stuck > 200) {
      return { ranges, rows, failures, cursor: cursor - 1n, complete: false };
    }
    await sleep(5_000);
  }

  return { ranges, rows, failures, cursor: cursor - 1n, complete: cursor > toBlock };
}
