import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { largeSwapsFor, largestSwaps } from '../../volume/largeSwaps.js';

/**
 * The trades that stood out, rather than the total they add up to.
 *
 * `/volume` says a pool traded $160M in a day. This says which trades made it
 * up, which is the question anyone actually asks about a thin market — and it
 * is answerable at all only because the volume measurement stopped throwing
 * the individual logs away.
 *
 * Recorded, not live: the volume job runs every six hours over a rolling 24h
 * window, so this covers what those passes saw. A trade from ten minutes ago
 * is not here yet, and `measuredAt` says how stale the newest row is rather
 * than leaving a reader to assume it is current.
 */
export function registerTrades(app: FastifyInstance): void {
  app.get('/trades', async (req, reply) => {
    const q = (req.query ?? {}) as { symbol?: string; limit?: string };
    const symbol = q.symbol?.trim().toUpperCase() || null;

    const rawLimit = Number(q.limit ?? 20);
    if (!Number.isFinite(rawLimit) || rawLimit <= 0 || rawLimit > 100) {
      return reply.code(400).send({ error: 'limit must be between 1 and 100' });
    }
    const limit = Math.floor(rawLimit);

    const newest = getDb()
      .prepare('SELECT MAX(observed_at) AS at, COUNT(*) AS n FROM large_swaps')
      .get() as { at: number | null; n: number };

    const measurement = {
      recorded: Number(newest.n),
      measuredAt: newest.at === null ? null : new Date(Number(newest.at)).toISOString(),
      note:
        'the largest few swaps per stock-paired pool, captured while the 24h volume window is ' +
        'measured (every 6h). usd is null where the stock has no Chainlink feed — unknowable, ' +
        'never zero. side is the stock side: buy means stock left the pool.',
    };

    if (!symbol) {
      return { trades: largestSwaps(limit), symbol: null, limit, measurement };
    }

    const known = getDb().prepare('SELECT 1 FROM stock_tokens WHERE symbol = ?').get(symbol);
    if (!known) {
      return reply.code(404).send({ error: `${symbol} is not a stock token on this chain` });
    }

    const trades = largeSwapsFor(symbol, limit);
    return {
      symbol,
      limit,
      trades,
      measurement,
      // Empty is a fact about what has been recorded, not about the chain. A
      // caller has to be able to tell "nothing that big happened" from "this
      // has not been measured yet", and the two read identically otherwise.
      note:
        trades.length === 0
          ? measurement.recorded === 0
            ? 'nothing recorded yet on this deployment; the volume job captures trades every 6h'
            : `no trade in ${symbol} has cleared the recording floor since measurement began`
          : undefined,
    };
  });
}
