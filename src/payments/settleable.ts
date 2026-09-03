import { facilitatorConfigured, x402Config } from '../../config/x402.js';
import { facilitatorSupported, supports } from './facilitator.js';

/**
 * Whether the `exact` scheme may honestly be advertised.
 *
 * The 402 body used to offer `exact` on the strength of `X402_FACILITATOR_URL`
 * being set, which asks the wrong question. A facilitator that does not settle
 * `exact` on this network refuses every authorization signed against that
 * advertisement -- so the body promised a door that does not open, and the
 * caller found out only after signing. That was not hypothetical: the open
 * facilitator at x402.org lists `exact` on base-sepolia, solana-devnet and six
 * other testnets, and nothing on Base mainnet.
 *
 * So the facilitator is asked what it settles, and the answer decides what is
 * offered. Three properties matter:
 *
 *  - **Fail closed.** Never asked, could not be reached, answered without this
 *    network: `exact` is not advertised. Silence is not consent.
 *  - **Never blocking.** `exactSettlement()` is synchronous and answers from
 *    cache, kicking off a refresh when the answer is old. A 402 is the reply
 *    to a caller who is already waiting; it does not get to wait longer for a
 *    third party.
 *  - **Not flapping.** A positive answer is held for five minutes and keeps
 *    being served while the next probe runs. A negative one is retried after a
 *    minute, because that is the state an operator is actively fixing and a
 *    five-minute wait to see a fix land is its own small lie.
 *
 * A stale positive can outlive the truth by one probe. The cost of that is
 * bounded and is not money: `verifyPayment` still asks the facilitator on every
 * paid call, and a facilitator that has gone away answers 503 there, which
 * charges nobody.
 */

const OK_TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;

export interface ExactVerdict {
  /** Whether the 402 may name `exact`. */
  advertise: boolean;
  /** Why, in words an operator can act on. Reported by /x402/supported. */
  reason: string;
  /** When the facilitator last answered, or null if it never has. */
  checkedAt: number | null;
}

let verdict: ExactVerdict | null = null;
let inflight: Promise<ExactVerdict> | null = null;

function fresh(v: ExactVerdict, now: number): boolean {
  if (v.checkedAt === null) return false;
  return now - v.checkedAt < (v.advertise ? OK_TTL_MS : FAIL_TTL_MS);
}

/** Never rejects: an unreachable facilitator is an answer, not an exception. */
async function probe(): Promise<ExactVerdict> {
  const url = x402Config.facilitatorUrl;
  const network = x402Config.network;
  try {
    const kinds = await facilitatorSupported();
    const ok = supports(kinds, 'exact', network);
    return {
      advertise: ok,
      reason: ok
        ? `${url} settles exact on ${network}`
        : `${url} does not settle exact on ${network}` +
          (kinds.length ? `; it lists ${kinds.length} other kind(s)` : '; it lists nothing'),
      checkedAt: Date.now(),
    };
  } catch (err) {
    return {
      advertise: false,
      reason: `${url} could not be asked: ${(err as Error).message.slice(0, 200)}`,
      checkedAt: Date.now(),
    };
  }
}

/**
 * Ask the facilitator now and cache the answer.
 *
 * Concurrent callers share one probe rather than each opening their own
 * connection to a service that is, in the failing case, already unwell.
 */
export function refreshSettlement(): Promise<ExactVerdict> {
  if (!facilitatorConfigured()) {
    verdict = {
      advertise: false,
      reason: 'X402_FACILITATOR_URL is not set, so there is nothing to settle exact through',
      checkedAt: Date.now(),
    };
    return Promise.resolve(verdict);
  }
  inflight ??= probe()
    .then((v) => {
      verdict = v;
      return v;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * The verdict, without waiting. Triggers a refresh when the cached answer is
 * missing or old, and answers from what is already known meanwhile.
 */
export function exactSettlement(): ExactVerdict & { stale: boolean } {
  if (!facilitatorConfigured()) {
    return {
      advertise: false,
      reason: 'X402_FACILITATOR_URL is not set, so there is nothing to settle exact through',
      checkedAt: null,
      stale: false,
    };
  }
  const now = Date.now();
  const known = verdict;
  if (!known || !fresh(known, now)) void refreshSettlement();
  if (!known) {
    return {
      advertise: false,
      reason: 'the facilitator has not answered yet; asking it now',
      checkedAt: null,
      stale: true,
    };
  }
  return { ...known, stale: !fresh(known, now) };
}

/** Testing seam: forget what the facilitator said. */
export function resetSettlement(): void {
  verdict = null;
  inflight = null;
}
