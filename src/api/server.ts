import Fastify from 'fastify';
import { env } from '../../config/chain.js';
import { registerQuote } from './routes/quote.js';
import { registerGas } from './routes/gas.js';
import { registerPrepareSwap } from './routes/prepareSwap.js';
import { registerCorporateActions } from './routes/corporateActions.js';
import { registerAsk } from './routes/ask.js';
import { computeCoverage } from '../registry/coverage.js';
import { getDb } from '../db/index.js';
import { registerMetering } from './metering.js';

export function buildServer() {
  const app = Fastify({ logger: true });

  // Before the routes, so every priced response carries its price.
  registerMetering(app);

  app.get('/health', async () => {
    const db = getDb();
    const n = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    // Both protocols, and how far each index has actually walked. A health
    // check that reported only v4 would look green while a third of the
    // stock-paired volume went unindexed.
    const cursors = Object.fromEntries(
      (
        db.prepare('SELECT stream, last_block FROM cursor').all() as unknown as Array<{
          stream: string;
          last_block: number;
        }>
      )
        .filter((c) => !c.stream.startsWith('crosscheck:'))
        .map((c) => [c.stream, Number(c.last_block)]),
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
      cursors,
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
  return app;
}
