import { timingSafeEqual } from 'node:crypto';
import { gatewayTrusted, x402Config } from '../../config/x402.js';

/**
 * Requests that arrive already paid, through Bankr's hosted payment wall.
 *
 * Bankr's x402 offering is a gateway rather than a facilitator: it publishes
 * the endpoint, issues the 402, takes the USDC on Base, settles it, and only
 * then forwards the request here. So on this path there is nothing to verify
 * and nothing to settle — the question is narrower and sharper: **is this
 * request really from the gateway?**
 *
 * It matters because the gateway also tells us who paid, in `x-402-payer`.
 * That header is the whole value of the path — per-payer quotas, per-payer
 * logs, an identity without an account — and it is a plain string that anyone
 * can set. Trusting it because it is present would turn the payment wall into
 * decoration: set the header, skip the payment.
 *
 * So the shared secret is the boundary, exactly as the Neynar webhook's
 * signature is the boundary for autonomous replies. `x-bankr-secret` matches
 * what the gateway was configured with (VATES_BACKEND_SECRET) or the request
 * is treated as unpaid, and the payer it claims is ignored rather than
 * recorded. With no secret configured there is no trusted gateway path at
 * all, which is the honest outcome: better a 402 the operator can explain
 * than a wall anyone can step around.
 */

/** Shared secret, sent by the gateway on every forwarded request. */
export const GATEWAY_SECRET_HEADER = 'x-bankr-secret';
/** Who paid, as the gateway settled it. Meaningless without the secret. */
export const GATEWAY_PAYER_HEADER = 'x-402-payer';

export interface GatewayRequest {
  /** True only when the shared secret matched. Nothing else grants this. */
  trusted: boolean;
  /** The paying address, lowercased. Null unless trusted. */
  payer: string | null;
  /** Why it is or is not trusted, for logs and for /x402/supported. */
  reason: string;
}

const header = (headers: Record<string, unknown>, name: string): string | undefined => {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

function secretMatches(presented: string): boolean {
  const expected = Buffer.from(x402Config.gateway.secret, 'utf8');
  const given = Buffer.from(presented.trim(), 'utf8');
  // Length is compared first because timingSafeEqual throws on a mismatch;
  // the length of a secret is not the part worth protecting.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/**
 * What, if anything, this request proves about having been paid for.
 *
 * Returns a verdict rather than a boolean so the caller can say *why* in a
 * log line: "no secret configured" and "wrong secret presented" are the same
 * refusal and completely different problems.
 */
export function readGatewayRequest(headers: Record<string, unknown>): GatewayRequest {
  const claimedPayer = header(headers, GATEWAY_PAYER_HEADER);
  const secret = header(headers, GATEWAY_SECRET_HEADER);

  if (!secret && !claimedPayer) {
    return { trusted: false, payer: null, reason: 'not a gateway request' };
  }
  if (!gatewayTrusted()) {
    return {
      trusted: false,
      payer: null,
      reason:
        'VATES_BACKEND_SECRET is not set on this origin, so a gateway request cannot be told ' +
        'apart from anyone setting the same headers',
    };
  }
  if (!secret) {
    return { trusted: false, payer: null, reason: `no ${GATEWAY_SECRET_HEADER} presented` };
  }
  if (!secretMatches(secret)) {
    return { trusted: false, payer: null, reason: `${GATEWAY_SECRET_HEADER} did not match` };
  }

  // Paid, and by whom. A malformed payer is not a reason to refuse a settled
  // payment -- the money is collected either way -- so it is dropped and the
  // request is still served.
  const payer =
    claimedPayer && /^0x[0-9a-fA-F]{40}$/.test(claimedPayer.trim())
      ? claimedPayer.trim().toLowerCase()
      : null;
  return {
    trusted: true,
    payer,
    reason: payer ? `settled by the gateway for ${payer}` : 'settled by the gateway',
  };
}
