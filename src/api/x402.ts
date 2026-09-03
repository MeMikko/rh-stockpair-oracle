import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { PAYMENT_CHAIN_ID, paymentConfig } from '../../config/payments.js';
import { ROUTE_PRICES, priceFor, pricingMode } from '../../config/pricing.js';
import {
  facilitatorConfigured, gatewayAdvertised, gatewayTrusted, resourceUrl, x402Config,
} from '../../config/x402.js';
import { claimCredit } from '../payments/verify.js';
import { addCredit, creditBalance, spendCredit } from '../payments/credit.js';
import { assetDomain, type AssetDomain } from '../payments/asset.js';
import {
  FacilitatorUnavailable, settlePayment, verifyPayment, X402_VERSION,
  type PaymentPayload, type PaymentRequirements,
} from '../payments/facilitator.js';
import { readGatewayRequest } from '../payments/gateway.js';
import { exactSettlement, refreshSettlement } from '../payments/settleable.js';
import { tierForSession } from '../auth/session.js';

/**
 * x402: pay-per-call for agents, over HTTP 402.
 *
 * The point is that a caller needs no account, no key and no prior
 * relationship — it calls, gets a 402 describing what to pay, pays, and calls
 * again. That is the right shape for an agent that found this service in a
 * catalogue thirty seconds ago.
 *
 * **Two schemes are offered, and the standard one is offered first.**
 *
 *  - `exact` — the published x402 scheme. The caller signs an EIP-3009
 *    authorization, sends it in `X-PAYMENT`, and a facilitator checks it and
 *    submits it. Nobody funds a wallet, nobody pays gas, and every
 *    off-the-shelf client — x402-fetch, an app's `bankr.x402.fetch` — already
 *    speaks it. This is what makes the service callable by an agent that has
 *    never heard of it. The facilitator is a standard open one; Bankr
 *    publishes no facilitator API for other people's servers.
 *  - `onchain-transfer-credit` — the older path, kept because callers use it.
 *    An ordinary USDC transfer whose hash is presented afterwards buys a
 *    balance that many calls draw down. It is honestly named: advertising it
 *    as `exact` once made standard clients sign an authorization nobody read
 *    and loop on the retry.
 *
 * A third door belongs to Bankr's hosted gateway, which is Bankr's actual
 * x402 product: it issues its own 402, takes the payment, settles on Base and
 * forwards the request here with `x-402-payer`. Nothing is verified or settled
 * in this process on that path — the only question is whether the request is
 * really from the gateway, which is what the shared secret answers. See
 * `src/payments/gateway.ts`.
 *
 * Off while `PRICING_MODE=launch`: everything is served, the 402 never fires,
 * and the price headers say what it will cost. Flipping to `paid` turns this
 * on.
 */

const HEADER_PAYMENT = 'x-payment';
/**
 * The other name the same thing travels under.
 *
 * x402-fetch and every client built on it send `X-PAYMENT`. Bankr's own
 * hand-rolled example sends `PAYMENT-SIGNATURE`. Both are the same base64
 * payload, so both are read: refusing a payment over the header it arrived in
 * is a 402 the caller cannot debug.
 */
const HEADER_PAYMENT_ALT = 'payment-signature';
const HEADER_RESPONSE = 'x-payment-response';


export const LEGACY_SCHEME = 'onchain-transfer-credit';

// The credit ledger moved to src/payments/credit.ts, where the claim path can
// write to it inside its own transaction. Re-exported because callers -- and
// the tests -- know it by this name.
export { addCredit, creditBalance, spendCredit } from '../payments/credit.js';

/** Price of a route in USDC base units. */
function priceUnitsFor(route: string): bigint {
  const usd = priceFor(route);
  if (usd === null || usd <= 0) return 0n;
  return BigInt(Math.round(usd * 10 ** paymentConfig.usdcDecimals));
}

/**
 * What a caller must do to pay, in the order it should be tried.
 *
 * `exact` is listed first, and only when a facilitator is configured: a
 * scheme advertised with nothing behind it produces a signature that gets
 * refused for reasons the caller cannot act on. When there is no facilitator
 * the 402 carries the credit scheme alone and says why, which at least names
 * something that works.
 */
export function requirementsFor(route: string, domain: AssetDomain): PaymentRequirements[] {
  const units = priceUnitsFor(route);
  const out: PaymentRequirements[] = [];

  // Not `is a facilitator configured` -- `will that facilitator settle this`.
  // A URL in the environment is a claim; /supported is the answer. See
  // src/payments/settleable.ts.
  if (exactSettlement().advertise) {
    out.push({
      scheme: 'exact',
      network: x402Config.network,
      // Both spellings of the price: v1 says maxAmountRequired, the v2 bodies
      // Bankr emits say amount. Same number, one extra field, one fewer class
      // of client that reads the wrong key and finds nothing.
      maxAmountRequired: units.toString(),
      amount: units.toString(),
      // Absolute, so an authorization signed for this service cannot be
      // replayed against another deployment of this code.
      resource: resourceUrl(route),
      description: `One call to ${route}`,
      mimeType: 'application/json',
      payTo: paymentConfig.treasury,
      maxTimeoutSeconds: x402Config.maxTimeoutSeconds,
      asset: paymentConfig.usdc,
      // The EIP-712 domain the authorization is signed against, read off the
      // token rather than remembered. `domainSource` says which it was.
      extra: { name: domain.name, version: domain.version, domainSource: domain.source },
    });
  }

  out.push({
    scheme: LEGACY_SCHEME,
    network: x402Config.network,
    chainId: PAYMENT_CHAIN_ID,
    asset: paymentConfig.usdc,
    assetSymbol: 'USDC',
    assetDecimals: paymentConfig.usdcDecimals,
    payTo: paymentConfig.treasury,
    maxAmountRequired: units.toString(),
    amount: units.toString(),
    resource: resourceUrl(route),
    description: `One call to ${route}`,
    mimeType: 'application/json',
    maxTimeoutSeconds: x402Config.maxTimeoutSeconds,
  });

  return out;
}

/**
 * The 402 body. Everything an agent needs to pay and retry without reading
 * documentation first.
 */
export function payment402Body(route: string, domain: AssetDomain) {
  const accepts = requirementsFor(route, domain);
  const hasExact = accepts.some((a) => a.scheme === 'exact');

  return {
    x402Version: X402_VERSION,
    accepts,
    settlement: {
      // True now, and the thing a standard client needs to know first.
      standardX402: hasExact,
      facilitator: hasExact ? x402Config.facilitatorUrl : null,
      standardX402Note: hasExact
        ? 'scheme `exact`: sign an EIP-3009 authorization, send it base64-encoded in the ' +
          'X-PAYMENT header (PAYMENT-SIGNATURE is read too), and it is verified and settled ' +
          'through the facilitator above. Gas is the facilitator’s, not yours.'
        : 'The `exact` scheme is not offered here: ' + exactSettlement().reason +
          '. Pay through the Bankr gateway below, or use the credit scheme — both work. ' +
          'Nothing was withheld from you; the door simply is not there to open.',
      // The alternative, said explicitly because it is the part that differs
      // from a naive reading of x402.
      creditScheme: LEGACY_SCHEME,
      mode: 'prepaid-credit',
      howToPay:
        `Send USDC on Base to ${paymentConfig.treasury}, then POST the hash to /x402/topup ` +
        `(or retry with header ${HEADER_PAYMENT}: <transaction hash>). The full amount becomes ` +
        'credit and each call debits its own price. Any amount works, with no minimum; larger ' +
        'transfers mean fewer transfers.',
      creditEndpoint: 'GET /x402/balance?payer=0x…',
      // A caller that already pays for things through Bankr should be told
      // where to call rather than left to find it, and a caller that does not
      // should not be sent somewhere it has no account.
      bankrGateway: gatewayAdvertised()
        ? {
            url: x402Config.gateway.url,
            note:
              'Bankr hosts a payment wall in front of this service. Call it there and Bankr ' +
              'issues the 402, takes the USDC on Base and forwards the paid request here.',
            trustedByOrigin: gatewayTrusted(),
          }
        : null,
    },
  };
}

/** Backwards-compatible synchronous view, used by the service descriptor. */
export function paymentRequirements(route: string) {
  return payment402Body(route, { name: 'USD Coin', version: '2', source: 'fallback' });
}

/** Routes that x402 gates. `/health` and `/coverage` stay free by design. */
function isGated(route: string | undefined): route is string {
  if (!route) return false;
  const p = priceFor(route);
  return p !== null && p > 0;
}

/* ------------------------------------------------ single-use authorizations */

/**
 * An authorization may be served once.
 *
 * EIP-3009 nonces are single-use on chain, so a replay cannot be *settled*
 * twice — but between verify and settle there is a window in which the same
 * authorization could buy two responses and pay for one. Claiming the nonce
 * locally before the work is done closes it, and costs one indexed insert.
 */
function authorizationKey(payload: PaymentPayload): string {
  const inner = payload.payload as { authorization?: { nonce?: unknown } } | undefined;
  const nonce = inner?.authorization?.nonce;
  if (typeof nonce === 'string' && nonce.length > 0) return nonce.toLowerCase();
  // No nonce field means a scheme variant we do not know the shape of. The
  // payload itself is still a stable identity for the payment, so hash it
  // rather than leaving the replay window open.
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function claimAuthorization(key: string, route: string, payer: string | undefined): boolean {
  try {
    getDb()
      .prepare(
        `INSERT INTO x402_authorizations (nonce, route, payer, claimed_at, status)
         VALUES (?, ?, ?, ?, 'claimed')`,
      )
      .run(key, route, payer ?? null, Date.now());
    return true;
  } catch {
    // Primary-key collision: this authorization has already bought a call.
    return false;
  }
}

function recordSettlement(key: string, status: 'settled' | 'failed', tx: string | null): void {
  getDb()
    .prepare('UPDATE x402_authorizations SET status = ?, settled_tx = ? WHERE nonce = ?')
    .run(status, tx, key);
}

/** A failed settlement frees the authorization: the caller may retry with it. */
function releaseAuthorization(key: string): void {
  getDb().prepare('DELETE FROM x402_authorizations WHERE nonce = ?').run(key);
}

/* ------------------------------------------------------------- the hooks -- */

/**
 * Swap a built response for a different one, from inside onSend.
 *
 * content-length is set explicitly because the original was computed for the
 * payload being discarded: leaving it means a truncated or hanging response,
 * which is a far more confusing failure than the payment error it hides.
 */
function replaceWith(reply: FastifyReply, code: number, body: unknown): string {
  const text = JSON.stringify(body);
  reply.code(code);
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('content-length', Buffer.byteLength(text));
  return text;
}

interface PendingPayment {
  key: string;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
}

/** Decoded `X-PAYMENT`, whatever form it arrived in. */
type PresentedPayment =
  | { kind: 'exact'; payload: PaymentPayload }
  | { kind: 'txHash'; hash: string }
  | { kind: 'payer'; address: string }
  | { kind: 'unreadable'; error: string }
  | { kind: 'none' };

export function readPaymentHeader(raw: string | string[] | undefined): PresentedPayment {
  const header = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!header) return { kind: 'none' };

  // A transaction hash tops the balance up; it is idempotent, so a caller that
  // sends the same hash on every request simply keeps using the credit that
  // hash already bought.
  if (/^0x[0-9a-fA-F]{64}$/.test(header)) return { kind: 'txHash', hash: header.toLowerCase() };
  // A bare address draws on credit that is already there.
  if (/^0x[0-9a-fA-F]{40}$/.test(header)) return { kind: 'payer', address: header.toLowerCase() };

  let decoded: string;
  try {
    decoded = Buffer.from(header, 'base64').toString('utf8');
  } catch {
    return { kind: 'unreadable', error: 'X-PAYMENT is neither base64 nor a 0x… hash or address' };
  }
  let parsed: PaymentPayload;
  try {
    parsed = JSON.parse(decoded) as PaymentPayload;
  } catch {
    return { kind: 'unreadable', error: 'X-PAYMENT did not base64-decode to JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.scheme !== 'string') {
    return { kind: 'unreadable', error: 'X-PAYMENT payload has no scheme' };
  }
  return { kind: 'exact', payload: parsed };
}

declare module 'fastify' {
  interface FastifyRequest {
    x402Pending?: PendingPayment;
  }
}

export function registerX402(app: FastifyInstance): void {
  // Ask the facilitator once at boot rather than on the first caller's 402.
  // Fire-and-forget on purpose: registration must not depend on a third party
  // being up, and a failed probe is a verdict (do not advertise) rather than a
  // failure to start.
  void refreshSettlement();

  app.get('/x402/balance', async (req, reply) => {
    const payer = (req.query as { payer?: string } | undefined)?.payer?.trim();
    if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) {
      return reply.code(400).send({ error: 'pass ?payer=0x…' });
    }
    const bal = creditBalance(payer);
    return {
      payer: payer.toLowerCase(),
      balanceUnits: bal.toString(),
      balanceUsdc: (Number(bal) / 10 ** paymentConfig.usdcDecimals).toFixed(6),
      pricingMode,
    };
  });

  /**
   * Buy credit with a transfer.
   *
   * Its own route rather than a side effect of a failed call, because that is
   * what a caller looking for it expects to find, and because a top-up should
   * be answerable with the balance it produced.
   */
  app.post('/x402/topup', async (req, reply) => {
    const body = req.body as { txHash?: unknown } | undefined;
    const txHash = typeof body?.txHash === 'string' ? body.txHash : '';
    if (!txHash) return reply.code(400).send({ error: 'body must be {"txHash": "0x…"}' });

    const res = await claimCredit(txHash);
    if (!res.ok) return reply.code(400).send({ ok: false, error: res.error });

    const d = 10 ** paymentConfig.usdcDecimals;
    return {
      ok: true,
      payer: res.payer,
      creditedUnits: res.creditedUnits,
      creditedUsdc: (Number(BigInt(res.creditedUnits)) / d).toFixed(6),
      balanceUnits: res.balanceUnits,
      balanceUsdc: (Number(BigInt(res.balanceUnits)) / d).toFixed(6),
      alreadyClaimed: res.alreadyClaimed,
      note: `Send header ${HEADER_PAYMENT}: ${res.payer} on priced calls to draw on this balance.`,
    };
  });

  /** What this deployment will actually accept, without having to fail first. */
  app.get('/x402/supported', async () => {
    const domain = await assetDomain();
    // First caller waits for one probe so the answer is measured rather than
    // "not yet known"; everyone after reads the cache.
    if (facilitatorConfigured() && exactSettlement().checkedAt === null) {
      await refreshSettlement();
    }
    const settlement = exactSettlement();
    return {
      pricingMode,
      x402Version: X402_VERSION,
      schemes: requirementsFor('/quote', domain).map((r) => r.scheme),
      network: x402Config.network,
      facilitator: facilitatorConfigured() ? x402Config.facilitatorUrl : null,
      // Whether that facilitator settles what this service advertises, asked
      // rather than assumed. An operator who pointed the URL at a testnet-only
      // facilitator reads it here instead of hearing it from a caller whose
      // signature was refused.
      exactSettlement: {
        advertised: settlement.advertise,
        reason: settlement.reason,
        checkedAt: settlement.checkedAt === null
          ? null
          : new Date(settlement.checkedAt).toISOString(),
      },
      asset: { address: paymentConfig.usdc, symbol: 'USDC', eip712: domain },
      perCallUsd: ROUTE_PRICES,
      // The gateway is reported with whether this origin can actually tell a
      // request from it apart from a forgery. An operator who forgot the
      // shared secret finds out here rather than from a caller.
      bankrGateway: gatewayAdvertised()
        ? { url: x402Config.gateway.url, trustedByOrigin: gatewayTrusted() }
        : null,
    };
  });

  /**
   * A free route reached through Bankr's gateway, which charged for it anyway.
   *
   * The deployed gateway is a path-preserving reverse proxy with its 402 in
   * front of the whole path space, so `…/vates/health` costs $0.02 — measured
   * 2026-09-03, resource `…/vates/health` in its own 402 body. This origin
   * cannot prevent that: Bankr settles before the request arrives, and there
   * is nothing here to refund.
   *
   * What it can do is make sure the caller pays once rather than repeatedly.
   * The header names the URL where the same answer is free, on the response
   * they already paid for. Set regardless of PRICING_MODE, because the gateway
   * charges regardless of it.
   */
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const free = req.routeOptions?.url;
    if (!free || isGated(free)) return;
    if (priceFor(free) !== 0) return;
    if (!readGatewayRequest(req.headers as Record<string, unknown>).trusted) return;
    reply.header('x-oracle-free-at-origin', resourceUrl(free));
  });

  /**
   * The same fact in the body, because that is what an agent reads.
   *
   * A header is for a client written by a person. The callers this service is
   * built for parse the JSON and never look at the headers, so a notice only
   * in a header is a notice to nobody. Additive: no existing field changes, so
   * a consumer that does not know about this one is unaffected.
   *
   * Keyed off the header set above, which is set only for a trusted gateway
   * request on a free route -- so a direct caller's response is untouched.
   */
  app.addHook('onSend', async (_req, reply, payload) => {
    const free = reply.getHeader('x-oracle-free-at-origin');
    if (typeof free !== 'string' || typeof payload !== 'string') return payload;
    if (!payload.startsWith('{')) return payload;
    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return payload;
    const text = JSON.stringify({
      ...(body as Record<string, unknown>),
      freeAtOrigin: {
        url: free,
        note:
          'This route is free. You reached it through the Bankr gateway, which prices its ' +
          'whole path space and charged for this call; the URL above is the same answer at ' +
          'no cost. Nothing here can refund what was already settled.',
      },
    });
    reply.header('content-length', Buffer.byteLength(text));
    return text;
  });

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (pricingMode !== 'paid') return;
    const route = req.routeOptions?.url;
    if (!isGated(route)) return;

    // 1. Bankr's gateway, which took the payment before the request got here.
    const gateway = readGatewayRequest(req.headers as Record<string, unknown>);
    if (gateway.trusted) {
      reply.header('x-oracle-settled-by', 'bankr-gateway');
      if (gateway.payer) reply.header('x-oracle-payer', gateway.payer);
      return;
    }
    if (gateway.reason !== 'not a gateway request') {
      // Logged rather than silently 402'd: a request that looks like the
      // gateway and is not is either a misconfiguration on the gateway or
      // someone trying the door, and those need telling apart.
      req.log.warn(`x402 gateway request refused: ${gateway.reason}`);
    }

    // 2. A pro subscriber already paid for the period. Billing them per call
    // as well would be theft by carelessness.
    const cookie = req.headers.cookie;
    const auth = req.headers.authorization;
    const token =
      typeof auth === 'string' && auth.startsWith('Bearer ')
        ? auth.slice(7).trim()
        : typeof cookie === 'string'
          ? cookie.match(/(?:^|;\s*)oracle_session=([^;]+)/)?.[1]
          : undefined;
    if (tierForSession(token).tier === 'pro') return;

    const cost = priceUnitsFor(route);
    const presented = readPaymentHeader(
      req.headers[HEADER_PAYMENT] ?? req.headers[HEADER_PAYMENT_ALT],
    );
    const domain = await assetDomain();

    const refuse = (extra: Record<string, unknown> = {}, error = 'payment required') =>
      reply.code(402).send({ error, ...payment402Body(route, domain), ...extra });

    if (presented.kind === 'none') return refuse();
    if (presented.kind === 'unreadable') return refuse({ detail: presented.error }, presented.error);

    // 3. The standard scheme, settled through the facilitator.
    if (presented.kind === 'exact') {
      const requirements = requirementsFor(route, domain).find(
        (r) => r.scheme === presented.payload.scheme,
      );
      if (!requirements || requirements.scheme === LEGACY_SCHEME) {
        // Most often this is `exact` arriving at a deployment whose facilitator
        // cannot settle it. Saying which is the difference between a caller
        // retrying forever and one switching to a scheme that works.
        return refuse(
          {
            detail: `scheme ${presented.payload.scheme} is not accepted here`,
            why: presented.payload.scheme === 'exact' ? exactSettlement().reason : undefined,
          },
          'unsupported payment scheme',
        );
      }

      let verified;
      try {
        verified = await verifyPayment(presented.payload, requirements);
      } catch (err) {
        // The facilitator being down is our problem, not the caller's, and a
        // 402 would tell them to pay again for a payment that may be fine.
        req.log.error(`x402 verify failed: ${(err as Error).message}`);
        return reply.code(503).send({
          error: 'payment verification is unavailable; nothing was charged',
          detail: err instanceof FacilitatorUnavailable ? err.message.slice(0, 200) : undefined,
          retryable: true,
        });
      }
      if (!verified.isValid) {
        return refuse(
          { detail: verified.invalidReason ?? 'the facilitator refused this payment' },
          'payment rejected',
        );
      }

      const key = authorizationKey(presented.payload);
      if (!claimAuthorization(key, route, verified.payer)) {
        return refuse(
          { detail: 'that authorization has already been used; sign a new one' },
          'authorization already used',
        );
      }

      // Settled in onSend, once there is a response worth charging for.
      req.x402Pending = { key, payload: presented.payload, requirements };
      return;
    }

    // 4. Credit: a top-up hash, or an address drawing on a balance.
    let payer: string;
    if (presented.kind === 'txHash') {
      const res = await claimCredit(presented.hash);
      if (!res.ok) return refuse({ detail: res.error }, 'top-up rejected');
      payer = res.payer;
    } else {
      payer = presented.address;
    }

    if (spendCredit(payer, cost)) {
      reply.header(
        HEADER_RESPONSE,
        Buffer.from(
          JSON.stringify({
            success: true,
            scheme: LEGACY_SCHEME,
            payer,
            charged: cost.toString(),
            remaining: creditBalance(payer).toString(),
          }),
        ).toString('base64'),
      );
      return;
    }

    return refuse({
      payer,
      balanceUnits: creditBalance(payer).toString(),
      shortfallUnits: (cost - creditBalance(payer)).toString(),
    });
  });

  /**
   * Settle after the work, before the answer.
   *
   * Settling first would charge for a response that then failed; settling
   * after sending would leave nothing to tell the caller with when settlement
   * is refused. So it happens here, and a refusal replaces the response with
   * the 402 it should have been.
   */
  app.addHook('onSend', async (req, reply, payload) => {
    const pending = req.x402Pending;
    if (!pending) return payload;
    req.x402Pending = undefined;

    // Nothing was served, so nothing is owed. Release the authorization so the
    // caller can retry with the same signature rather than signing again.
    if (reply.statusCode >= 400) {
      releaseAuthorization(pending.key);
      return payload;
    }

    let settled;
    try {
      settled = await settlePayment(pending.payload, pending.requirements);
    } catch (err) {
      releaseAuthorization(pending.key);
      req.log.error(`x402 settle failed: ${(err as Error).message}`);
      return replaceWith(reply, 502, {
        error: 'payment could not be settled; nothing was charged and nothing was served',
        detail: (err as Error).message.slice(0, 200),
        retryable: true,
      });
    }

    if (!settled.success) {
      releaseAuthorization(pending.key);
      recordSettlement(pending.key, 'failed', null);
      const domain = await assetDomain();
      req.log.warn(`x402 settlement refused: ${settled.errorReason ?? 'no reason given'}`);
      return replaceWith(reply, 402, {
        error: 'payment settlement failed',
        detail: settled.errorReason ?? 'the facilitator did not settle this payment',
        ...payment402Body(req.routeOptions?.url ?? '', domain),
      });
    }

    recordSettlement(pending.key, 'settled', settled.transaction ?? null);
    reply.header(
      HEADER_RESPONSE,
      Buffer.from(
        JSON.stringify({
          success: true,
          scheme: pending.requirements.scheme,
          network: settled.network ?? pending.requirements.network,
          transaction: settled.transaction ?? null,
          payer: settled.payer ?? null,
        }),
      ).toString('base64'),
    );
    return payload;
  });
}

/** Stable id for a request, used only in logs. */
export const requestFingerprint = (req: FastifyRequest): string =>
  createHash('sha256').update(`${req.ip}:${req.routeOptions?.url ?? ''}`).digest('hex').slice(0, 8);
