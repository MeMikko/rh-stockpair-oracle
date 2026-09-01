import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { getDb } from '../../db/index.js';
import { tokenMeta } from '../../registry/tokenMeta.js';
import { labelHook, DYNAMIC_FEE_FLAG } from '../../../config/addresses.js';
import { feedFor } from '../../registry/feeds.js';
import { readFeed, type OracleRead } from '../../pricing/chainlink.js';
import { readPoolState, priceFromSqrtX96, activeLiquidityDepth } from '../../pricing/poolState.js';
import { quoteExactIn } from '../../pricing/impact.js';
import { readMultiplier, type MultiplierState } from '../../pricing/multiplier.js';
import { marketStatus } from '../../pricing/marketHours.js';
import { computeDeviation } from '../../pricing/deviation.js';
import { stockTokenMap } from '../../registry/stockTokens.js';

interface PoolRecord {
  pool_id: string; currency0: string; currency1: string; fee: number;
  tick_spacing: number; hooks: string; stock_side: number | null;
  stock_symbol: string | null; paired_token: string | null; quote_kind: string;
}

export function registerQuote(app: FastifyInstance): void {
  app.get('/quote', async (req, reply) => {
    const q = req.query as { pool?: string; size?: string };
    if (!q.pool) return reply.code(400).send({ error: 'pool query param required (v4 poolId)' });

    const pool = getDb()
      .prepare('SELECT * FROM pools WHERE pool_id = ?')
      .get(q.pool.toLowerCase()) as PoolRecord | undefined;
    if (!pool) return reply.code(404).send({ error: 'pool not indexed', poolId: q.pool });

    const [meta0, meta1] = await Promise.all([
      tokenMeta(pool.currency0), tokenMeta(pool.currency1),
    ]);
    const dec0 = meta0.decimals, dec1 = meta1.decimals;
    const state = await readPoolState(pool.pool_id as Hex, pool.fee);
    const spot = priceFromSqrtX96(state.sqrtPriceX96, dec0, dec1);
    const depth = activeLiquidityDepth(state.liquidity, state.sqrtPriceX96, dec0, dec1);

    let oracle: OracleRead | null = null;
    let multiplier: MultiplierState | null = null;
    let impliedUsd: number | null = null;
    let deviation: Awaited<ReturnType<typeof computeDeviation>> = {
      deviation: null, reason: 'pool_not_stock_paired',
      poolImpliedStockUsd: null, referenceUsd: null,
    };

    if (pool.quote_kind === 'stock' && pool.stock_symbol && pool.paired_token) {
      const stockAddr = pool.stock_side === 0 ? pool.currency0 : pool.currency1;
      multiplier = await readMultiplier(stockAddr as Address);

      const feed = feedFor(pool.stock_symbol);
      // 159 of 194 stock tokens have no Chainlink feed. Report that explicitly
      // rather than omitting the field: a consumer must be able to tell
      // "no deviation" apart from "deviation unknowable".
      if (feed) oracle = await readFeed(feed);

      // spot is currency1 per currency0; normalise to stock tokens per paired token.
      const stockPerPaired = pool.stock_side === 0 ? 1 / spot : spot;
      if (oracle) impliedUsd = stockPerPaired * oracle.priceUsd;

      deviation = await computeDeviation(
        pool.stock_symbol, pool.paired_token, stockPerPaired, oracle, stockTokenMap(),
      );
    }

    let impact = null;
    let impactError: string | null = null;
    if (q.size) {
      const zeroForOne = pool.stock_side !== 0; // sell the paired token into the pool
      const decIn = zeroForOne ? dec0 : dec1;
      const decOut = zeroForOne ? dec1 : dec0;
      try {
        const amountIn = BigInt(Math.round(Number(q.size) * 10 ** decIn));
        const r = await quoteExactIn(
          {
            currency0: pool.currency0 as Address, currency1: pool.currency1 as Address,
            fee: pool.fee, tickSpacing: pool.tick_spacing, hooks: pool.hooks as Address,
          },
          zeroForOne, amountIn, spot, decIn, decOut,
        );
        impact = {
          amountIn: r.amountIn.toString(), amountOut: r.amountOut.toString(),
          executionPrice: r.executionPrice, priceImpact: r.priceImpact,
          gasEstimate: r.gasEstimate.toString(), source: r.source,
        };
      } catch (err) {
        impactError = `quoter_failed: ${(err as Error).message.slice(0, 140)}`;
      }
    }

    return {
      poolId: pool.pool_id,
      chainId: 4663,
      pair: {
        currency0: pool.currency0, currency1: pool.currency1,
        decimals0: dec0, decimals1: dec1,
        decimalsSource0: meta0.source, decimalsSource1: meta1.source,
        quoteKind: pool.quote_kind, stockSymbol: pool.stock_symbol,
        pairedToken: pool.paired_token,
      },
      pool: {
        fee: pool.fee,
        feeIsDynamic: pool.fee === DYNAMIC_FEE_FLAG,
        liveLpFee: state.lpFee,
        tickSpacing: pool.tick_spacing,
        tick: state.tick,
        hooks: pool.hooks,
        hookLabel: labelHook(pool.hooks),
        liquidity: state.liquidity.toString(),
      },
      price: {
        spotCurrency1PerCurrency0: spot,
        impliedUsdOfPairedToken: impliedUsd,
        measurement: impliedUsd === null ? 'unavailable' : 'measured',
      },
      depth: { ...depth, note: 'active-tick estimate; excludes out-of-range liquidity' },
      oracle: {
        feed: oracle,
        deviation: deviation.deviation,
        deviationReason: deviation.reason,
        poolImpliedStockUsd: deviation.poolImpliedStockUsd,
        referenceUsd: deviation.referenceUsd,
      },
      corporateAction: multiplier
        ? {
            currentMultiplier: multiplier.current.toString(),
            pendingMultiplier: multiplier.pending?.toString() ?? null,
            effectiveAt: multiplier.effectiveAt,
            actionPending: multiplier.actionPending,
            oraclePaused: multiplier.oraclePaused,
          }
        : null,
      market: marketStatus(),
      impact,
      impactError,
      generatedAt: new Date().toISOString(),
    };
  });
}
