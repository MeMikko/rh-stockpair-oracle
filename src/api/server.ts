import Fastify from 'fastify';
import { env } from '../../config/chain.js';
import { registerQuote } from './routes/quote.js';
import { registerGas } from './routes/gas.js';
import { registerPrepareSwap } from './routes/prepareSwap.js';
import { registerCorporateActions } from './routes/corporateActions.js';
import { computeCoverage } from '../registry/coverage.js';
import { getDb } from '../db/index.js';

export function buildServer() {
  const app = Fastify({ logger: true });

  app.get('/health', async () => {
    const pools = getDb().prepare('SELECT COUNT(*) AS n FROM pools').get() as { n: number };
    const stock = getDb()
      .prepare("SELECT COUNT(*) AS n FROM pools WHERE quote_kind = 'stock'")
      .get() as { n: number };
    return { ok: true, chainId: 4663, poolsIndexed: Number(pools.n), stockPaired: Number(stock.n) };
  });

  // Oracle coverage is a headline fact, not a diagnostic: most stock tokens
  // have no Chainlink feed, and nothing else publishes that.
  app.get('/coverage', async () => computeCoverage());

  registerQuote(app);
  registerGas(app);
  registerPrepareSwap(app);
  registerCorporateActions(app);
  return app;
}
