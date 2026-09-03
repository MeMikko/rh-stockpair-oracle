import { facilitatorConfigured, x402Config } from '../../config/x402.js';

/**
 * The facilitator, whoever it is.
 *
 * A facilitator does the two things a resource server should not have to do
 * itself: check that a signed payment authorization is valid and will settle,
 * and submit it. Its gas, not the caller's, which is what makes a $0.005 call
 * payable at all — the caller signs, nobody funds a wallet, and no
 * transaction is broadcast by this process.
 *
 * **It is not Bankr.** Bankr's x402 product is a hosted gateway that issues
 * its own 402 in front of this origin (see `gateway.ts`); it publishes no
 * `/verify` or `/settle` for other people's servers. This path is for callers
 * that pay this origin directly, and it speaks the published x402 wire
 * protocol — `POST /verify`, `POST /settle`, `GET /supported`, each taking
 * `{ x402Version, paymentPayload, paymentRequirements }` — so any conforming
 * facilitator works, Coinbase's at x402.org/facilitator included. That is
 * deliberate: a payment path with exactly one possible provider is an outage
 * waiting to be someone else's.
 *
 * Nothing here throws into a request path. Every failure comes back as a
 * value with a reason a caller can act on, because the alternative is a 500
 * on a call the caller may already have paid for.
 */

export const X402_VERSION = 1;

/** What a caller must pay, in the shape x402 defines. */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
  [k: string]: unknown;
}

/** What the caller sent in `X-PAYMENT`, decoded. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

export interface VerifyResult {
  isValid: boolean;
  /** Present when invalid. The facilitator's own words, passed through. */
  invalidReason?: string;
  payer?: string;
}

export interface SettleResult {
  success: boolean;
  errorReason?: string;
  /** Settlement transaction. Facilitators name this `transaction` or `txHash`. */
  transaction?: string;
  network?: string;
  payer?: string;
}

export class FacilitatorUnavailable extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  if (!facilitatorConfigured()) {
    throw new FacilitatorUnavailable('X402_FACILITATOR_URL is not set');
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (x402Config.facilitatorKey) headers['x-api-key'] = x402Config.facilitatorKey;

  let res: Response;
  try {
    res = await fetch(`${x402Config.facilitatorUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(x402Config.timeoutMs),
    });
  } catch (err) {
    throw new FacilitatorUnavailable(
      `${x402Config.facilitatorUrl}${path}: ${(err as Error).message}`,
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    const b = parsed as { error?: string; message?: string } | null;
    const detail = b?.message ?? b?.error ?? (typeof parsed === 'string' ? parsed.slice(0, 200) : '');
    throw new FacilitatorUnavailable(`${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return parsed as T;
}

/**
 * Is this payment good?
 *
 * Called before the work is done, so a bad authorization costs an RPC round
 * trip at the facilitator rather than a quoter simulation here.
 */
export async function verifyPayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<VerifyResult> {
  const res = await post<VerifyResult & { valid?: boolean; reason?: string }>('/verify', {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  });
  // Field names have drifted between facilitator implementations. Read both
  // spellings rather than treating an unrecognised success as a refusal --
  // refusing a caller who paid is the expensive direction of this mistake.
  const isValid = res.isValid ?? res.valid ?? false;
  return { isValid, invalidReason: res.invalidReason ?? res.reason, payer: res.payer };
}

/**
 * Submit the payment.
 *
 * Called after the response is built and before it is sent: settling first
 * would charge for work that then failed, and settling after sending leaves
 * nothing to tell the caller with when settlement is refused.
 */
export async function settlePayment(
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirements,
): Promise<SettleResult> {
  const res = await post<SettleResult & { txHash?: string; error?: string }>('/settle', {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements,
  });
  return {
    success: Boolean(res.success),
    errorReason: res.errorReason ?? res.error,
    transaction: res.transaction ?? res.txHash,
    network: res.network,
    payer: res.payer,
  };
}

export interface SupportedKind {
  x402Version?: number;
  scheme?: string;
  network?: string;
}

/**
 * What the facilitator will actually settle.
 *
 * The point of asking rather than assuming: a facilitator that does not do
 * `exact` on `base` will refuse every payment this service advertises, and
 * finding that out from a caller's failed call is finding it out too late.
 */
export async function facilitatorSupported(): Promise<SupportedKind[]> {
  if (!facilitatorConfigured()) {
    throw new FacilitatorUnavailable('X402_FACILITATOR_URL is not set');
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (x402Config.facilitatorKey) headers['x-api-key'] = x402Config.facilitatorKey;

  let res: Response;
  try {
    res = await fetch(`${x402Config.facilitatorUrl}/supported`, {
      headers,
      signal: AbortSignal.timeout(x402Config.timeoutMs),
    });
  } catch (err) {
    throw new FacilitatorUnavailable(
      `${x402Config.facilitatorUrl}/supported: ${(err as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new FacilitatorUnavailable(`/supported → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { kinds?: SupportedKind[] } | SupportedKind[];
  return Array.isArray(body) ? body : (body.kinds ?? []);
}

/** Does the configured facilitator settle what this service advertises? */
export function supports(kinds: SupportedKind[], scheme: string, network: string): boolean {
  return kinds.some(
    (k) =>
      (k.scheme ?? '').toLowerCase() === scheme &&
      (k.network ?? '').toLowerCase() === network.toLowerCase(),
  );
}
