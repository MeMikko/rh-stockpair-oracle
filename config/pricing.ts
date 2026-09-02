/**
 * What each endpoint is intended to cost, and what it costs today.
 *
 * The service launches without payment wired up, but it is not a free service
 * and must not be advertised as one -- "free forever" is a promise that would
 * have to be broken. So prices live here from the start, are published on
 * every response, and turning billing on later is a mode change rather than a
 * redesign.
 *
 * Pricing follows the suggested x402 band for this ecosystem ($0.005-$0.02),
 * at the bottom of it: adoption is the goal, so the price exists to cover the
 * upstream RPC calls a request causes rather than to earn margin.
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
 * Intended price per call, USD. The three tiers reflect real upstream cost:
 * an index read touches only local SQLite, a chain read costs an RPC round
 * trip, and a quoter simulation costs several.
 */
export const ROUTE_PRICES: Record<string, number> = {
  // Index reads. Local, cheap to serve.
  '/health': 0,
  '/coverage': 0,
  '/corporate-actions': 0.005,
  '/ask': 0.005,

  // Chain reads. Each costs upstream RPC.
  '/gas': 0.01,

  // Quoter simulations. The most expensive thing here to serve.
  '/quote': 0.01,
  '/prepare-swap': 0.01,
};

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
