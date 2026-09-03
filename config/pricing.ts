/**
 * What each endpoint is intended to cost, and what it costs today.
 *
 * The service launches without payment wired up, but it is not a free service
 * and must not be advertised as one -- "free forever" is a promise that would
 * have to be broken. So prices live here from the start, are published on
 * every response, and turning billing on later is a mode change rather than a
 * redesign.
 *
 * Pricing follows the suggested x402 band for this ecosystem ($0.005-$0.02).
 * It used to sit at the bottom of it, in two tiers that tracked what a call
 * costs to serve. It is now ONE price, $0.02, for every priced route.
 *
 * The reason is the payment surface, not the cost of serving. Bankr's hosted
 * gateway prices an endpoint, not a route: a caller paying through
 * x402.bankr.bot/<wallet>/vates pays one figure whatever it then calls. Two
 * tiers could not be expressed there, and the alternatives were both worse
 * than a flat price -- charge everything at the cheap tier and sell a quoter
 * simulation below what it costs, or publish a split the gateway does not
 * honour and have callers discover it by being charged something else.
 *
 * So: one price, published identically on every surface -- the response
 * headers, the 402 body, the service descriptor, the gateway dashboard. A
 * caller can read one number and be right everywhere.
 */

export type PricingMode = 'launch' | 'paid';

/**
 * 'launch' serves every route without charge while still publishing what it
 * will cost. Switch to 'paid' only once a payment path is actually wired up --
 * this flag does not itself collect anything.
 */
export const pricingMode: PricingMode =
  process.env.PRICING_MODE === 'paid' ? 'paid' : 'launch';

/**
 * Priced routes. Anything absent from this map is unpriced *and* unmetered --
 * which is why /webhooks/farcaster is deliberately not here. It is inbound
 * from Neynar rather than a call anyone makes, and counting it would put the
 * webhook in the usage figures the pricing decision is meant to read.
 */
export const ROUTE_PRICES: Record<string, number> = {
  // Free, and staying free: a health check the proxy polls every 30 seconds,
  // and the coverage split that says which of these prices can even produce a
  // Chainlink deviation.
  '/health': 0,
  '/coverage': 0,

  // Everything else, at one price. $0.02 is the top of the band rather than
  // the bottom, which is the honest consequence of a single figure: the
  // expensive routes set it, because the cheap ones cannot subsidise them
  // without being sold below cost.
  '/corporate-actions': 0.02,
  '/ask': 0.02,
  '/pools': 0.02,
  '/volume': 0.02,
  '/price': 0.02,
  '/gas': 0.02,
  '/quote': 0.02,
  '/prepare-swap': 0.02,
  '/history': 0.02,
};

/** The one price every priced route carries. Exported so nothing hardcodes it. */
export const FLAT_PRICE_USD = 0.02;

/** Price for a route, or null when the route is not priced. */
export function priceFor(route: string): number | null {
  const p = ROUTE_PRICES[route];
  return p === undefined ? null : p;
}

/**
 * What a caller is actually charged right now. Always 0 during launch --
 * stated separately from the intended price so a caller can see both what it
 * pays today and what it will pay, and plan accordingly.
 */
export function chargedFor(route: string): number {
  if (pricingMode === 'launch') return 0;
  return priceFor(route) ?? 0;
}
