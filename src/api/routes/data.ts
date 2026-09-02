import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/index.js';
import { feedFor } from '../../registry/feeds.js';
import { readFeed } from '../../pricing/chainlink.js';
import { marketStatus } from '../../pricing/marketHours.js';
import { buildVolumeReport } from '../../volume/usd.js';

/**
 * The endpoints that make `reproduce` true.
 *
 * An external test found the answer path pointing pool-count questions at
 * /corporate-actions, price questions at /coverage, and the volume split back
 * at /ask — one wrong, one wrong, one circular. Every answer promises a call
 * that reproduces it, and that promise is the whole service; pointing it at
 * roughly-related endpoints is worse than pointing it nowhere, because it
 * looks checkable and is not.
 *
 * The honest fix was to build what was being promised rather than to weaken
 * the claim.
 */

function symbolFrom(req: { query: unknown }): string | null {
  const raw = (req.query as { symbol?: string } | undefined)?.symbol?.trim();
  if (!raw) return null;
  // Symbols are matched as stored: uppercase, from the indexed universe.
  return /^[A-Za-z0-9.]{1,8}$/.test(raw) ? raw.toUpperCase() : null;
}

export function registerData(app: FastifyInstance): void {
  /**
   * Pool counts for a stock, split by protocol. What `pools` answers cite.
   */
  app.get('/pools', async (req, reply) => {
    const symbol = symbolFrom(req);
    if (!symbol) return reply.code(400).send({ error: 'pass ?symbol=NVDA' });

    const db = getDb();
    const count = (sql: string): number =>
      Number((db.prepare(sql).get(symbol) as { n: number }).n);

    const v4 = count("SELECT COUNT(*) AS n FROM pools WHERE stock_symbol = ?");
    const v3 = count('SELECT COUNT(*) AS n FROM pools_v3 WHERE stock_symbol = ?');
    const known = db.prepare('SELECT 1 FROM stock_tokens WHERE symbol = ?').get(symbol);

    if (!known) {
      return reply.code(404).send({ error: `${symbol} is not a stock token on this chain` });
    }
    return { symbol, chainId: 4663, v4Pools: v4, v3Pools: v3, totalPools: v4 + v3 };
  });

  /**
   * A stock's own USD price from its Chainlink feed.
   *
   * Deliberately not derived from a pool: a pool quoting NVDA implies a price
   * for the token paired against it, not for NVDA. Where there is no feed this
   * returns 404 with the reason rather than substituting one.
   */
  app.get('/price', async (req, reply) => {
    const symbol = symbolFrom(req);
    if (!symbol) return reply.code(400).send({ error: 'pass ?symbol=TSLA' });

    const feed = feedFor(symbol);
    if (!feed) {
      return reply.code(404).send({
        error: `${symbol} has no Chainlink feed on this chain`,
        reason: 'no_feed',
        note:
          'A pool quoting this token implies a price for the token paired against it, ' +
          'not for this stock. 159 of 194 stock tokens are in this position; see /coverage.',
      });
    }

    try {
      const read = await readFeed(feed);
      const market = marketStatus(new Date());
      return {
        symbol,
        chainId: 4663,
        priceUsd: read.priceUsd,
        source: 'chainlink',
        proxy: read.proxy,
        updatedAt: read.updatedAt,
        ageSeconds: read.ageSeconds,
        // Stale means past the feed's own heartbeat, not merely old: these
        // feeds publish on a 0.5% deviation threshold with a long heartbeat,
        // so a multi-hour-old answer is normal.
        stale: read.stale,
        heartbeatSeconds: feed.heartbeat,
        market: { open: market.isOpen, session: market.session },
      };
    } catch (err) {
      return reply.code(502).send({
        error: `could not read the ${symbol} feed`,
        detail: (err as Error).message.slice(0, 160),
      });
    }
  });

  /**
   * The 24h stock-paired volume split, with the window it was measured over.
   *
   * The window matters more than the number. Volume is a rolling measurement
   * refreshed by a scheduled job, so a consumer needs to know how old it is --
   * an external test correctly flagged the figures as untrustworthy precisely
   * because nothing said when they were taken.
   */
  app.get('/volume', async () => {
    const rep = await buildVolumeReport();
    let v4 = 0;
    let v3 = 0;
    for (const p of rep.pools) {
      if (p.volumeUsd === null) continue;
      if (p.protocol === 'v4') v4 += p.volumeUsd;
      else v3 += p.volumeUsd;
    }
    const total = v4 + v3;
    const r1 = (n: number): number => Number(n.toFixed(1));
    const ageSeconds = rep.toTs > 0 ? Math.max(0, Math.floor(Date.now() / 1000) - rep.toTs) : null;

    return {
      chainId: 4663,
      window: {
        hours: r1(rep.hours),
        fromBlock: rep.fromBlock,
        toBlock: rep.toBlock,
        fromTs: rep.fromTs,
        toTs: rep.toTs,
        // How long ago the window closed. This is the number that says whether
        // to trust the figures, so it is reported rather than left to be
        // inferred from a cursor.
        measuredSecondsAgo: ageSeconds,
        refreshedEvery: '6h',
      },
      usd: {
        total: r1(total / 1e6),
        v4: r1(v4 / 1e6),
        v3: r1(v3 / 1e6),
        unit: 'millions',
        v3SharePercent: total > 0 ? Math.round((v3 / total) * 100) : null,
      },
      pools: { priced: rep.pricedPools, unpriceable: rep.unpricedPools },
      note:
        'Priced from the stock side via Chainlink. Pools whose stock has no feed are ' +
        'counted in `unpriceable` and excluded from the totals rather than estimated.',
    };
  });
}

/** Exported for the answer layer, so a reproduce string is never hand-written twice. */
export const REPRODUCE = {
  pools: (symbol: string) => `GET /pools?symbol=${symbol}`,
  price: (symbol: string) => `GET /price?symbol=${symbol}`,
  volume: () => 'GET /volume',
  coverage: () => 'GET /coverage',
  gas: () => 'GET /gas',
  corporateActions: (days = 30) => `GET /corporate-actions?withinDays=${days}`,
  quote: (poolRef: string) => `GET /quote?pool=${poolRef}`,
  health: () => 'GET /health',
} as const;
