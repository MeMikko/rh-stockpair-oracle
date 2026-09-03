import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import {
  bestSampledPool, driftBySession, historyDepth, snapshotsForPool, volumeHistory,
} from '../../history/series.js';

/**
 * What this service saw, rather than what it sees.
 *
 * Every other route answers about now, and now is available to anyone with an
 * RPC key. This one answers about a period, and a period is available only to
 * whoever was recording during it. The public RPC has no archive and Alchemy's
 * free tier caps `eth_getLogs` at ten blocks, so nobody can start today and
 * produce last week — which is what makes this the one endpoint here that a
 * competitor cannot match by being cleverer.
 *
 * The honest consequence: on a fresh deployment it answers with nothing, and
 * says so. `GET /health` publishes the depth for free, so a caller finds out
 * whether a series exists before paying for one.
 */

const HOURS_MAX = 24 * 90;

function hoursFrom(raw: string | undefined): { ok: true; hours: number } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, hours: 24 };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > HOURS_MAX) return { ok: false };
  return { ok: true, hours: n };
}

export function registerHistory(app: FastifyInstance): void {
  app.get('/history', async (req, reply) => {
    const q = (req.query ?? {}) as { pool?: string; symbol?: string; hours?: string };
    const symbol = q.symbol?.trim().toUpperCase() || null;
    const poolRef = q.pool?.trim().toLowerCase() || null;

    const h = hoursFrom(q.hours);
    if (!h.ok) {
      return reply.code(400).send({
        error: `hours must be a positive number no greater than ${HOURS_MAX}`,
      });
    }
    if (!symbol && !poolRef) {
      return reply.code(400).send({
        error: 'pass ?pool=<v4 poolId or v3 address> or ?symbol=NVDA',
        depth: historyDepth(),
        note: 'GET /health reports how much history exists, free.',
      });
    }

    const sinceMs = Date.now() - h.hours * 3_600_000;
    const depth = historyDepth();

    let pool = poolRef;
    let sampledFor: string | null = null;
    if (!pool && symbol) {
      const known = getDb()
        .prepare('SELECT 1 FROM stock_tokens WHERE symbol = ?')
        .get(symbol);
      if (!known) {
        return reply.code(404).send({ error: `${symbol} is not a stock token on this chain` });
      }
      const best = bestSampledPool(symbol);
      if (!best) {
        // Not a 404: the symbol is real and the question is answerable in
        // principle. What is missing is time, and saying which is missing is
        // the difference between "wrong ticker" and "come back tomorrow".
        return reply.send({
          symbol,
          hours: h.hours,
          samples: 0,
          snapshots: [],
          driftBySession: [],
          depth,
          note:
            depth.snapshots === 0
              ? 'nothing has been recorded yet on this deployment; sampling writes a row every few minutes'
              : `no snapshots for ${symbol} yet — sampling covers the busiest stock-paired pools first`,
        });
      }
      pool = best.poolKey;
      sampledFor = symbol;
    }

    const snapshots = snapshotsForPool(pool!, sinceMs);
    const volume = volumeHistory(pool!, Math.floor(sinceMs / 1000));

    return {
      pool,
      symbol: symbol ?? sampledFor,
      hours: h.hours,
      since: new Date(sinceMs).toISOString(),
      samples: snapshots.length,
      // Gaps are left as gaps. Nothing is interpolated or filled forward: a
      // series that invents its missing points is not evidence.
      snapshots,
      volumeWindows: volume,
      driftBySession: symbol ? driftBySession(symbol, sinceMs) : [],
      depth,
      measurement: {
        snapshotEvery: 'a few minutes, busiest stock-paired pools first',
        volumeEvery: '6h, as a rolling 24h window',
        note:
          'deviation: null means no Chainlink feed for that stock, so drift was unknowable — ' +
          'never that it was zero. Sessions are recorded on the same row as the price, not ' +
          'joined afterwards.',
      },
    };
  });
}
