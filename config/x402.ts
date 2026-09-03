/**
 * x402, settled through Bankr.
 *
 * The first version of this service spoke a 402 that was x402-*shaped* and
 * said so: an ordinary USDC transfer whose hash was presented afterwards,
 * named `onchain-transfer-credit` precisely so a standard client would fail
 * cleanly instead of signing an authorization nobody read. That was honest and
 * useless — no off-the-shelf x402 client could pay it, which is the entire
 * point of speaking the protocol.
 *
 * The missing piece was a facilitator: someone to check an EIP-3009
 * authorization and submit it. Bankr runs one, covers the gas, and is where
 * the callers this service is built for already are. So the `exact` scheme is
 * now real — verified and settled through whatever facilitator is configured
 * here — and the transfer-and-credit scheme stays as a second entry in the
 * same 402 for callers that already use it.
 *
 * **Nothing here is a guess that fails silently.** The facilitator URL has no
 * default: a wrong one would 402 every caller with an error that reads like a
 * payment problem. `npm run x402:check` asks the configured facilitator what
 * it actually supports, the same way `npm run bankr:scope` asks Bankr what a
 * key can actually do.
 */

const env = (name: string): string => process.env[name]?.trim() ?? '';

/**
 * Service keys, for a handler that has already collected the money.
 *
 * Bankr x402 Cloud hosts the handler, applies the payment layer and settles
 * on Base; the handler then calls this origin. That call is already paid for,
 * so charging it again would bill the same request twice. The key says "this
 * caller settled elsewhere", and is the only credential that skips payment
 * without a session or a signed authorization — which is why it is a shared
 * secret held by one deployment rather than anything a caller can present on
 * its own behalf.
 *
 * Format: `name:secret`, comma separated. The name is for the usage counter
 * and the logs; the secret is what is compared.
 */
function parseServiceKeys(raw: string): Array<{ name: string; secret: string }> {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      // A bare secret still works, named for what it is rather than rejected:
      // an operator who omits the label should get a working key, not a
      // silently ignored one.
      if (at < 0) return { name: 'service', secret: entry };
      return { name: entry.slice(0, at).trim() || 'service', secret: entry.slice(at + 1).trim() };
    })
    .filter((k) => k.secret.length >= 16);
}

export const x402Config = {
  /**
   * Facilitator base URL. `/verify`, `/settle` and `/supported` hang off it.
   * Empty means the `exact` scheme is not advertised at all — the 402 then
   * carries only the transfer-and-credit scheme, and says why.
   */
  facilitatorUrl: env('X402_FACILITATOR_URL').replace(/\/+$/, ''),

  /** Sent as `x-api-key`, the header Bankr uses everywhere else. Optional. */
  facilitatorKey: env('X402_FACILITATOR_KEY'),

  /** Network name as the facilitator names it. x402 uses slugs, not chain ids. */
  network: env('X402_NETWORK') || 'base',

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

  serviceKeys: parseServiceKeys(env('X402_SERVICE_KEYS')),
} as const;

export function facilitatorConfigured(): boolean {
  return /^https?:\/\//.test(x402Config.facilitatorUrl);
}

export function serviceKeysConfigured(): boolean {
  return x402Config.serviceKeys.length > 0;
}

/** Absolute URL a payment is bound to, so it cannot be replayed elsewhere. */
export function resourceUrl(route: string): string {
  return `${x402Config.resourceBase}${route}`;
}
