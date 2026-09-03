/**
 * The handler Bankr x402 Cloud hosts in front of this oracle.
 *
 * Bankr wraps it in the payment layer: it creates the wallet, applies x402,
 * settles USDC on Base and lists the endpoint where agents look for one. The
 * handler itself does nothing clever — it forwards an allowlisted call to the
 * origin at oracle.sb4s.xyz and hands back the JSON.
 *
 * **Why proxy at all, when the origin now speaks `exact` itself?** Discovery.
 * An agent that already pays for things through Bankr finds this in Bankr's
 * catalogue and calls it without ever having heard of oracle.sb4s.xyz. The
 * direct path stays open for callers that would rather pay the origin.
 *
 * The origin call carries `x-oracle-service-key`, which tells the origin the
 * money has already been collected here. That key is a shared secret: it skips
 * per-call payment, so it belongs in this deployment's environment and nowhere
 * a caller can reach.
 *
 * One handler, one price. Bankr prices an endpoint, not a route, so this is
 * deployed at the top tier ($0.01) and covers every route below. If the
 * cheaper routes are worth their own price, deploy a second handler with
 * ROUTES narrowed to them — do not price them all at $0.005 here, because that
 * would sell a quoter simulation for less than it costs to serve.
 *
 * Deploy (from the repo root, with the Bankr CLI authenticated):
 *
 *   bankr x402 deploy ./x402/oracle --price 0.01
 *
 * Check the scaffold `bankr x402 init` produces before the first deploy: the
 * handler signature below is the plain Request/Response shape, and if the CLI
 * hands you a different one, keep its wrapper and paste this body inside.
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
]);

/** Routes that take a body. Everything else is a GET with a query string. */
const POST_ROUTES = new Set(['/ask', '/prepare-swap']);

/**
 * Environment, read defensively.
 *
 * `process` exists on Bankr's Node runtime, and does not exist on every
 * worker runtime a handler might land on. Reading it through globalThis means
 * a missing `process` is a default rather than a ReferenceError at module load
 * -- which on a serverless runtime is an endpoint that 500s before it can say
 * why.
 */
const env = (name: string): string =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] ??
  '';

const ORIGIN = (env('ORACLE_ORIGIN') || 'https://oracle.sb4s.xyz').replace(/\/+$/, '');
const SERVICE_KEY = env('ORACLE_SERVICE_KEY');

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
      hint: 'pass ?route=/quote and the route’s own query parameters alongside it',
    });
  }

  const forwarded = new URLSearchParams(url.searchParams);
  forwarded.delete('route');
  const target = `${ORIGIN}${route}${forwarded.size ? `?${forwarded}` : ''}`;

  const isPost = POST_ROUTES.has(route) && request.method === 'POST';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (SERVICE_KEY) headers['x-oracle-service-key'] = SERVICE_KEY;
  if (isPost) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(target, {
      method: isPost ? 'POST' : 'GET',
      headers,
      body: isPost ? await request.text() : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // 502 rather than a body that looks like an answer: the caller paid for a
    // measurement, and an error shaped like data is worse than no data.
    return json(502, { error: 'oracle origin unreachable', detail: (err as Error).message });
  }

  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: {
      'content-type': res.headers.get('content-type') ?? 'application/json; charset=utf-8',
      // Passed through so a caller can still see what the origin says a call
      // costs, even when Bankr is the one charging for it.
      'x-oracle-price-usd': res.headers.get('x-oracle-price-usd') ?? '',
      'x-oracle-pricing': res.headers.get('x-oracle-pricing') ?? '',
    },
  });
}
