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
 */

const SALT =
  process.env.USAGE_SALT ??
  // A per-process fallback so an operator who never sets USAGE_SALT still
  // never persists anything that survives as a stable identifier.
  createHash('sha256').update(String(process.pid) + String(Date.now())).digest('hex');

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
        callerId(typeof key === 'string' ? key : undefined, req.ip),
        Date.now(),
      );
    } catch (err) {
      // Accounting must never break a response. A dropped count is a worse
      // outcome than a failed request only if you are the accountant.
      app.log.warn(`usage accounting failed: ${(err as Error).message.slice(0, 120)}`);
    }
  });
}
