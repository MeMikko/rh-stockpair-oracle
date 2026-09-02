import Fastify from 'fastify';
import { env } from '../../config/chain.js';
import { registerQuote } from './routes/quote.js';
import { registerGas } from './routes/gas.js';
import { registerPrepareSwap } from './routes/prepareSwap.js';
import { registerCorporateActions } from './routes/corporateActions.js';
import { registerAsk } from './routes/ask.js';
import { registerLanding } from './routes/landing.js';
import { registerWebhook } from './routes/webhook.js';
import { registerAuth } from './routes/auth.js';
import { registerPro } from './routes/pro.js';
import { registerData } from './routes/data.js';
import { registerDiscovery } from './routes/discovery.js';
import { registerX402 } from './x402.js';
import { computeCoverage } from '../registry/coverage.js';
import { getDb } from '../db/index.js';
import { getClient } from '../../config/chain.js';
import { registerMetering } from './metering.js';

export function buildServer() {
  const app = Fastify({ logger: true });

  // Before the routes, so every priced response carries its price.
  registerMetering(app);
  // Before the routes: a gated call must be paid for or refused with a 402
  // before any work is done on it.
  registerX402(app);

  app.get('/health', async () => {
    const db = getDb();
    const n = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    // Both protocols, and how far each index has actually walked. A health
    // check that reported only v4 would look green while a third of the
    // stock-paired volume went unindexed.
    const all = (
      db.prepare('SELECT stream, last_block FROM cursor').all() as unknown as Array<{
        stream: string;
        last_block: number;
      }>
    ).filter((c) => !c.stream.startsWith('crosscheck:'));

    // Two different things, reported separately. Pool discovery follows the
    // tip continuously; the swap-window cursors are where a periodic volume
    // measurement last looked, and are meaningless as a freshness signal for
    // the index. An external test reasonably read a 12-hour-old swap cursor as
    // a stale index -- because they were listed side by side as if they meant
    // the same thing.
    // Measured, not assumed: chain 4663 runs near 0.1s per block, and the
    // difference between that and one second is the difference between "1.4
    // hours behind" and "14 hours behind".
    const SECONDS_PER_BLOCK = 0.1;
    let tip: number | null = null;
    try {
      tip = Number(await getClient().getBlockNumber());
    } catch {
      tip = null;
    }

    const lagged = (p: (s: string) => boolean) =>
      Object.fromEntries(
        all
          .filter((c) => p(c.stream))
          .map((c) => {
            const block = Number(c.last_block);
            const behind = tip === null ? null : Math.max(0, tip - block);
            return [
              c.stream,
              {
                block,
                blocksBehind: behind,
                secondsBehind: behind === null ? null : Math.round(behind * SECONDS_PER_BLOCK),
              },
            ];
          }),
      );
    return {
      ok: true,
      chainId: 4663,
      v4: {
        pools: n('SELECT COUNT(*) AS n FROM pools'),
        stockPaired: n("SELECT COUNT(*) AS n FROM pools WHERE quote_kind = 'stock'"),
      },
      v3: {
        pools: n('SELECT COUNT(*) AS n FROM pools_v3'),
        stockPaired: n("SELECT COUNT(*) AS n FROM pools_v3 WHERE quote_kind = 'stock'"),
      },
      // Lag in seconds as well as blocks. An external test twice computed
      // "12 hours behind" from a block delta by assuming one-second blocks;
      // this chain runs at ~0.1s, so the real figure was a tenth of that.
      // Publishing only block numbers invites that arithmetic, so the seconds
      // are given directly.
      tip,
      secondsPerBlock: SECONDS_PER_BLOCK,
      cursors: lagged((s) => !s.includes(':swaps:')),
      volume: {
        // Where the last volume measurement looked, not where the index is.
        // GET /volume reports the window and its age directly.
        lastMeasuredCursors: lagged((s) => s.includes(':swaps:')),
        note: 'a rolling 24h measurement refreshed every 6h; see GET /volume for its window',
      },
    };
  });

  // Oracle coverage is a headline fact, not a diagnostic: most stock tokens
  // have no Chainlink feed, and nothing else publishes that.
  app.get('/coverage', async () => computeCoverage());

  registerQuote(app);
  registerGas(app);
  registerPrepareSwap(app);
  registerCorporateActions(app);
  registerAsk(app);
  registerLanding(app);
  registerWebhook(app);
  registerAuth(app);
  registerPro(app);
  registerData(app);
  registerDiscovery(app);
  return app;
}
