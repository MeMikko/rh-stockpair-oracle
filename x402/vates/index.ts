/**
 * The `vates` endpoint on Bankr x402 Cloud, in front of this oracle.
 *
 * Bankr hosts this handler, issues the 402, takes the USDC on Base, settles it,
 * and only then runs the code below — so nothing here deals with payment. What
 * it does is forward the paid request to `oracle.sb4s.xyz` and hand back the
 * JSON, carrying two headers that matter:
 *
 *  - `x-bankr-secret`, so the origin can tell a real gateway request from
 *    anyone who noticed that `x-402-payer` is a plain string. The origin treats
 *    a request without it as unpaid, which is why this is not optional here
 *    despite being optional in the platform's own docs.
 *  - `x-402-payer`, passed through unchanged. Bankr strips any caller-supplied
 *    value before this handler sees it, so the address here is the wallet that
 *    actually paid, and the origin counts usage against it.
 *
 * One endpoint, one price. Bankr prices an endpoint rather than a route, which
 * is why this service and the origin both charge one figure for everything
 * priced ($0.02) instead of the two tiers the origin used to publish.
 *
 * Deploy from the repo root, with the Bankr CLI authenticated:
 *
 *   bankr x402 env set VATES_BACKEND_SECRET=<same value as the origin's .env>
 *   bankr x402 env set ORACLE_ORIGIN=https://oracle.sb4s.xyz
 *   bankr x402 deploy vates
 *
 * The handler has 30 seconds and 256 MB. A quote is three RPC round trips plus
 * a quoter simulation, so the origin call is bounded well inside that and a
 * timeout here surfaces as a 504 rather than as a hung request that still bills.
 */

/** Routes an agent may reach through this endpoint. Nothing else is proxied. */
const ROUTES = new Set([
  '/quote',
  '/gas',
  '/price',
  '/pools',
  '/volume',
  '/corporate-actions',
  '/coverage',
  '/ask',
  '/prepare-swap',
  '/health',
]);

/** Routes that take a body. Everything else is a GET with a query string. */
const POST_ROUTES = new Set(['/ask', '/prepare-swap']);

/**
 * Environment, read defensively.
 *
 * `process` exists on Bankr's runtime, and reading it through globalThis means
 * a runtime without it is a default rather than a ReferenceError at module
 * load — which would be an endpoint that 500s before it can say why.
 */
const env = (name: string): string =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] ??
  '';

const ORIGIN = (env('ORACLE_ORIGIN') || 'https://oracle.sb4s.xyz').replace(/\/+$/, '');
const SECRET = env('VATES_BACKEND_SECRET');

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // The route travels as a query parameter because the marketplace addresses
  // one endpoint, not a path space: ?route=/quote&pool=0x…
  const route = url.searchParams.get('route') ?? '/quote';

  if (!ROUTES.has(route)) {
    return json(400, {
      error: `route ${route} is not proxied here`,
      routes: [...ROUTES],
      hint: 'pass ?route=/quote and that route’s own parameters alongside it',
    });
  }

  const forwarded = new URLSearchParams(url.searchParams);
  forwarded.delete('route');
  const query = forwarded.toString();
  const target = `${ORIGIN}${route}${query ? `?${query}` : ''}`;

  const isPost = POST_ROUTES.has(route) && request.method === 'POST';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (SECRET) headers['x-bankr-secret'] = SECRET;
  // Set by Bankr's router after settlement, with any caller-supplied value
  // stripped. Passed through so the origin can meter per payer.
  const payer = request.headers.get('x-402-payer');
  if (payer) headers['x-402-payer'] = payer;
  if (isPost) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(target, {
      method: isPost ? 'POST' : 'GET',
      headers,
      body: isPost ? await request.text() : undefined,
      // Inside Bankr's own 30s ceiling, so a slow origin fails as a timeout
      // here rather than as a killed invocation with no explanation.
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // A non-2xx means Bankr does not settle the payment. That is the right
    // outcome: the caller paid for a measurement and got none.
    return json(504, { error: 'oracle origin unreachable', detail: (err as Error).message });
  }

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json; charset=utf-8',
      // Passed through so a caller can still read what the origin says a call
      // costs, even though Bankr is the one charging for it.
      'x-oracle-price-usd': res.headers.get('x-oracle-price-usd') ?? '',
      'x-oracle-pricing': res.headers.get('x-oracle-pricing') ?? '',
    },
  });
}
