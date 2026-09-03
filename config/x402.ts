/**
 * x402: two doors, and Bankr is one of them.
 *
 * The first version of this service spoke a 402 that was x402-*shaped* and
 * said so: an ordinary USDC transfer whose hash was presented afterwards,
 * named `onchain-transfer-credit` precisely so a standard client would fail
 * cleanly instead of signing an authorization nobody read. That was honest and
 * useless — no off-the-shelf x402 client could pay it, which is the entire
 * point of speaking the protocol.
 *
 * There are two ways to fix that, and they are not alternatives: they answer
 * different callers, and both are configured here.
 *
 *  1. **Bankr's gateway.** Bankr hosts the payment wall itself, at
 *     `https://x402.bankr.bot/<wallet>/<service>`. It issues the 402, takes
 *     the payment, settles on Base, and forwards the verified request here
 *     with `x-402-payer` naming who paid. Nothing about payment happens in
 *     this process on that path, and it is where agents that already pay
 *     through Bankr look.
 *  2. **This origin, speaking `exact` directly.** For callers that would
 *     rather pay `oracle.sb4s.xyz` than a gateway: the caller signs an
 *     EIP-3009 authorization, and a facilitator verifies and submits it.
 *
 * **Which facilitator is an open question, and the check answers it.** Bankr's
 * own x402 Cloud endpoints advertise `https://api.bankr.bot/facilitator` in
 * their 402 bodies, but Bankr documents it as the facilitator *behind their
 * hosted endpoints* rather than as an open one for other people's origins;
 * whether it verifies and settles for this origin is a question for
 * `npm run x402:check`, not for a comment. Coinbase's
 * https://x402.org/facilitator is the standard open alternative. Point
 * `X402_FACILITATOR_URL` at whichever one the check says works.
 *
 * **Nothing here is a guess that fails silently.** The facilitator URL has no
 * default, and `npm run x402:check` asks whatever is configured what it
 * actually settles — the same way `npm run bankr:scope` asks Bankr what a key
 * can actually do, rather than trusting a memory of a dashboard toggle.
 */

const env = (name: string): string => process.env[name]?.trim() ?? '';

export const x402Config = {
  /**
   * Facilitator base URL for the direct `exact` path. `/verify`, `/settle`
   * and `/supported` hang off it. Empty means the `exact` scheme is not
   * advertised at all — the 402 then carries the credit scheme and the Bankr
   * gateway, and says why.
   *
   * See the note above on which URL belongs here: `npm run x402:check` is the
   * arbiter, not a comment in this file.
   */
  facilitatorUrl: env('X402_FACILITATOR_URL').replace(/\/+$/, ''),

  /** Optional bearer/api key for a facilitator that requires one. */
  facilitatorKey: env('X402_FACILITATOR_KEY'),

  /** Network name as the facilitator names it. x402 uses slugs, not chain ids. */
  network: env('X402_NETWORK') || 'base',

  /**
   * Protocol version advertised in the 402 body.
   *
   * The published spec this implements is 1; Bankr's hosted endpoints emit 2.
   * A caller's own version is never overridden by this -- whatever version a
   * payment payload declares is what the facilitator is asked to verify --
   * so this only decides what an unpaid caller is told to speak.
   */
  version: Number(env('X402_VERSION') || 1),

  /**
   * Public base URL, used to build the absolute `resource` a payment is
   * bound to. A relative path there lets the same authorization be replayed
   * against a different deployment of this code.
   */
  resourceBase: (env('X402_RESOURCE_BASE') || 'https://oracle.sb4s.xyz').replace(/\/+$/, ''),

  /** How long a caller has to pay after being told the price. */
  maxTimeoutSeconds: Number(env('X402_MAX_TIMEOUT_SECONDS') || 120),

  /** Facilitator request timeout. A verify that hangs must not hang the call. */
  timeoutMs: Number(env('X402_FACILITATOR_TIMEOUT_MS') || 10_000),

  /**
   * EIP-712 domain of the payment asset, when it cannot be read from chain.
   * Left empty on purpose: `src/payments/asset.ts` reads `name()` and
   * `version()` off the token itself, because a wrong domain here produces a
   * signature that verifies nowhere and an error message about nothing.
   */
  assetName: env('X402_ASSET_NAME'),
  assetVersion: env('X402_ASSET_VERSION'),

  /**
   * Bankr's hosted payment wall in front of this origin.
   *
   * `url` is advertised so a caller that pays through Bankr is told where to
   * call instead of being left to find it in a catalogue. It is documentation
   * only — this process never calls it.
   *
   * `secret` is the shared secret Bankr sends as `x-bankr-secret`, set as
   * VATES_BACKEND_SECRET on the gateway. It is what makes the gateway's
   * `x-402-payer` header *evidence* rather than a claim: without it, anyone
   * could set that header and walk through the payment wall, so a gateway
   * request without a matching secret is treated as unpaid. Leaving it empty
   * is therefore a decision to have no trusted gateway path, not a
   * convenience.
   */
  gateway: {
    url: env('X402_GATEWAY_URL'),
    secret: env('VATES_BACKEND_SECRET') || env('X402_GATEWAY_SECRET'),
  },
} as const;

export function facilitatorConfigured(): boolean {
  return /^https?:\/\//.test(x402Config.facilitatorUrl);
}

/** Whether a request from Bankr's gateway can be told apart from a forgery. */
export function gatewayTrusted(): boolean {
  return x402Config.gateway.secret.length >= 16;
}

export function gatewayAdvertised(): boolean {
  return /^https?:\/\//.test(x402Config.gateway.url);
}

/** Absolute URL a payment is bound to, so it cannot be replayed elsewhere. */
export function resourceUrl(route: string): string {
  return `${x402Config.resourceBase}${route}`;
}
