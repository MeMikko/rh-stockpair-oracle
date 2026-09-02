import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../db/index.js';
import { chargedFor, priceFor, pricingMode } from '../../config/pricing.js';

/**
 * Per-route usage accounting, and pricing published on every response.
 *
 * Two reasons this exists before billing does. Turning pricing on without
 * knowing who calls what, and how often, would be guesswork -- the price of a
 * call should be set from its measured cost and its measured demand. And a
 * caller planning around this service deserves to know what it will cost
 * before it starts costing, which a header on every response gives them.
 *
 * Callers are identified by API key when one is presented and otherwise by a
 * salted hash of the remote address. The raw address is never stored: this is
 * a usage counter, not a visitor log, and a per-install salt means the hashes
 * are not comparable across deployments either.
 *
 * Behind a CDN the remote address is the CDN's, not the caller's, so every
 * caller would collapse into a handful of edge IPs and the per-caller counts
 * would be worthless -- which is the one number a pricing decision needs.
 * clientIp therefore prefers the forwarded header when one is configured.
 */

const SALT =
  process.env.USAGE_SALT ??
  // A per-process fallback so an operator who never sets USAGE_SALT still
  // never persists anything that survives as a stable identifier.
  createHash('sha256').update(String(process.pid) + String(Date.now())).digest('hex');

/**
 * Header carrying the true client address, when a CDN sits in front.
 * Cloudflare sets CF-Connecting-IP; set TRUSTED_CLIENT_IP_HEADER to match
 * whatever is actually in front, or leave it unset when nothing is.
 *
 * Only honoured when explicitly configured. A forwarded header is caller
 * controlled, so trusting one by default would let anyone reaching the origin
 * directly forge their identity in the usage counter -- harmless for billing
 * that is not yet live, and exactly the sort of thing that stops being
 * harmless later. The reverse proxy must also be restricted to the CDN's
 * ranges, or the header can be set by anyone who finds the origin.
 */
const CLIENT_IP_HEADER = process.env.TRUSTED_CLIENT_IP_HEADER?.trim().toLowerCase();

function clientIp(req: { headers: Record<string, unknown>; ip: string }): string {
  if (!CLIENT_IP_HEADER) return req.ip;
  const raw = req.headers[CLIENT_IP_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0) return req.ip;
  // X-Forwarded-For style headers are a comma-separated chain; the client is
  // the first entry. CF-Connecting-IP is a single address, so this is a no-op
  // for it and correct for the general case.
  return value.split(',')[0]!.trim();
}

function callerId(apiKey: string | undefined, ip: string): string {
  if (apiKey) return `key:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  return `ip:${createHash('sha256').update(SALT + ip).digest('hex').slice(0, 16)}`;
}

const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);

export function registerMetering(app: FastifyInstance): void {
  const record = getDb().prepare(
    `INSERT INTO usage (day, route, caller, calls, last_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(day, route, caller) DO UPDATE SET
       calls = calls + 1, last_at = excluded.last_at`,
  );

  app.addHook('onSend', async (req, reply, payload) => {
    // routeOptions.url is the pattern ('/quote'), not the concrete path, so
    // query strings and ids never become separate rows.
    const route = req.routeOptions?.url ?? 'unknown';
    const price = priceFor(route);
    if (price !== null) {
      reply.header('x-oracle-price-usd', String(price));
      reply.header('x-oracle-charged-usd', String(chargedFor(route)));
      reply.header('x-oracle-pricing', pricingMode);
    }

    // Say explicitly what a CDN may keep. Nothing here should be cached by
    // default: a cached /quote is a stale price presented as a live one, and
    // a cached /prepare-swap is calldata with a min-out derived from a market
    // that has moved. /coverage changes only when the registry syncs.
    if (route === '/coverage') reply.header('cache-control', 'public, max-age=300');
    else if (route !== 'unknown') reply.header('cache-control', 'no-store');

    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url;
    // Only priced routes are counted. /health is polled by the proxy every
    // 30s and counting it would swamp the numbers the pricing decision needs.
    if (!route || priceFor(route) === null || route === '/health') return;
    if (reply.statusCode >= 500) return;

    try {
      const key = req.headers['x-api-key'];
      record.run(
        dayOf(Date.now()),
        route,
        callerId(
          typeof key === 'string' ? key : undefined,
          clientIp(req as unknown as { headers: Record<string, unknown>; ip: string }),
        ),
        Date.now(),
      );
    } catch (err) {
      // Accounting must never break a response. A dropped count is a worse
      // outcome than a failed request only if you are the accountant.
      app.log.warn(`usage accounting failed: ${(err as Error).message.slice(0, 120)}`);
    }
  });
}
