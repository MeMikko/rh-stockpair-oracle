import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { getDb } from '../../db/index.js';
import { tokenMeta } from '../../registry/tokenMeta.js';
import { labelHook, DYNAMIC_FEE_FLAG } from '../../../config/addresses.js';
import { readPoolState, priceFromSqrtX96, activeLiquidityDepth } from '../../pricing/poolState.js';
import { readV3PoolState } from '../../pricing/poolStateV3.js';
import { quoteExactIn, type ImpactResult } from '../../pricing/impact.js';
import { quoteExactInV3 } from '../../pricing/impactV3.js';
import { marketStatus } from '../../pricing/marketHours.js';
import { stockContext } from '../../pricing/stockContext.js';

/**
 * `/quote` speaks both protocols, because the chain does.
 *
 * v3 carries about a third of stock-paired volume here and four of the five
 * largest stock-paired pools are v3. The indexer has covered both from the
 * start; this endpoint used to answer `pool not indexed` for every v3 address,
 * which made "covers v4 and v3" true of the index and false of the service.
 *
 * The two protocols differ in exactly two places — where the state lives, and
 * how the quoter addresses a pool — so those are the only branches. Price,
 * depth, Chainlink deviation, corporate actions and market hours are computed
 * identically, which is what makes the two answers comparable.
 */

interface V4PoolRecord {
  pool_id: string; currency0: string; currency1: string; fee: number;
  tick_spacing: number; hooks: string; stock_side: number | null;
  stock_symbol: string | null; paired_token: string | null; quote_kind: string;
}

interface V3PoolRecord {
  address: string; token0: string; token1: string; fee: number;
  tick_spacing: number; stock_side: number | null;
  stock_symbol: string | null; paired_token: string | null; quote_kind: string;
}

/**
 * A size is checked before anything is read from the chain.
 *
 * `BigInt(Math.round(NaN))` throws, which used to surface as
 * `quoter_failed: Cannot convert NaN to a BigInt` — a chain error for a typo,
 * after three RPC round trips had already been spent on it.
 */
function sizeOf(raw: string | undefined): { ok: true; size: number | null } | { ok: false } {
  if (raw === undefined || raw === '') return { ok: true, size: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ok: false };
  return { ok: true, size: n };
}

const impactBody = (r: ImpactResult) => ({
  amountIn: r.amountIn.toString(),
  amountOut: r.amountOut.toString(),
  executionPrice: r.executionPrice,
  priceImpact: r.priceImpact,
  gasEstimate: r.gasEstimate.toString(),
  source: r.source,
  ...(r.ticksCrossed === undefined ? {} : { ticksCrossed: r.ticksCrossed }),
});

export function registerQuote(app: FastifyInstance): void {
  app.get('/quote', async (req, reply) => {
    const q = req.query as { pool?: string; size?: string };
    if (!q.pool) {
      return reply.code(400).send({
        error: 'pool query param required: a v4 poolId (32 bytes) or a v3 pool address',
        find: 'GET /pools?symbol=NVDA lists both, with their identifiers',
      });
    }

    const key = q.pool.toLowerCase();
    const db = getDb();
    const v4 = db.prepare('SELECT * FROM pools WHERE pool_id = ?').get(key) as
      | V4PoolRecord
      | undefined;
    // Looked up by address only when the v4 lookup missed: the two key spaces
    // cannot collide (32 bytes vs 20), so the order is about cost, not
    // correctness.
    const v3 = v4
      ? undefined
      : (db.prepare('SELECT * FROM pools_v3 WHERE address = ?').get(key) as V3PoolRecord | undefined);

    if (!v4 && !v3) {
      return reply.code(404).send({
        error: 'pool not indexed',
        poolId: q.pool,
        note:
          'Both protocols are indexed from their creation block, so an unknown identifier is ' +
          'usually a pool on another chain, or a v4 poolId given where an address belongs. ' +
          'GET /pools?symbol=… lists what is indexed for a stock.',
      });
    }

    // Before any RPC: a bad size is the caller's typo, not a chain failure.
    const size = sizeOf(q.size);
    if (!size.ok) {
      return reply.code(400).send({ error: 'size must be a positive number of whole tokens' });
    }

    const token0 = (v4?.currency0 ?? v3!.token0) as Address;
    const token1 = (v4?.currency1 ?? v3!.token1) as Address;
    const [meta0, meta1] = await Promise.all([tokenMeta(token0), tokenMeta(token1)]);
    const dec0 = meta0.decimals;
    const dec1 = meta1.decimals;

    // The one branch that matters for state: v4 keeps it behind StateView,
    // v3 in the pool contract itself. Kept as two typed values rather than a
    // union, so the fields only one protocol has cannot be read off the other
    // by accident.
    const s4 = v4 ? await readPoolState(v4.pool_id as Hex, v4.fee) : null;
    const s3 = v3 ? await readV3PoolState(v3.address as Address) : null;
    const sqrtPriceX96 = s4?.sqrtPriceX96 ?? s3!.sqrtPriceX96;
    const liquidity = s4?.liquidity ?? s3!.liquidity;
    const tick = s4?.tick ?? s3!.tick;
    const spot = priceFromSqrtX96(sqrtPriceX96, dec0, dec1);
    const depth = activeLiquidityDepth(liquidity, sqrtPriceX96, dec0, dec1);

    const record = v4
      ? {
          quoteKind: v4.quote_kind, stockSymbol: v4.stock_symbol,
          pairedToken: v4.paired_token, stockSide: v4.stock_side,
        }
      : {
          quoteKind: v3!.quote_kind, stockSymbol: v3!.stock_symbol,
          pairedToken: v3!.paired_token, stockSide: v3!.stock_side,
        };

    const { oracle, multiplier, impliedUsd, deviation } = await stockContext({
      ...record,
      currency0: token0,
      currency1: token1,
      spot,
    });

    let impact = null;
    let impactError: string | null = null;
    if (size.size !== null) {
      const zeroForOne = record.stockSide !== 0; // sell the paired token into the pool
      const decIn = zeroForOne ? dec0 : dec1;
      const decOut = zeroForOne ? dec1 : dec0;
      const amountIn = BigInt(Math.round(size.size * 10 ** decIn));
      try {
        impact = impactBody(
          v4
            ? await quoteExactIn(
                {
                  currency0: token0, currency1: token1, fee: v4.fee,
                  tickSpacing: v4.tick_spacing, hooks: v4.hooks as Address,
                },
                zeroForOne, amountIn, spot, decIn, decOut,
              )
            : await quoteExactInV3({
                tokenIn: zeroForOne ? token0 : token1,
                tokenOut: zeroForOne ? token1 : token0,
                // The live fee, not the indexed one. They agree on v3, and
                // reading it costs nothing beyond the call already made.
                fee: s3!.fee,
                amountIn, spotPrice: spot, zeroForOne,
                decimalsIn: decIn, decimalsOut: decOut,
              }),
        );
      } catch (err) {
        impactError = `quoter_failed: ${(err as Error).message.slice(0, 140)}`;
      }
    }

    return {
      // The identifier as given: a 32-byte poolId for v4, a pool address for
      // v3. Kept under one name so a caller can round-trip whatever it holds.
      poolId: v4?.pool_id ?? v3!.address,
      protocol: v4 ? 'v4' : 'v3',
      chainId: 4663,
      pair: {
        currency0: token0, currency1: token1,
        decimals0: dec0, decimals1: dec1,
        decimalsSource0: meta0.source, decimalsSource1: meta1.source,
        quoteKind: record.quoteKind, stockSymbol: record.stockSymbol,
        pairedToken: record.pairedToken,
      },
      pool: v4
        ? {
            fee: v4.fee,
            feeIsDynamic: v4.fee === DYNAMIC_FEE_FLAG,
            liveLpFee: s4!.lpFee,
            tickSpacing: v4.tick_spacing,
            tick,
            hooks: v4.hooks,
            hookLabel: labelHook(v4.hooks),
            liquidity: liquidity.toString(),
          }
        : {
            address: v3!.address,
            fee: s3!.fee,
            // v3 has no dynamic fee and no hook. Both are reported as false
            // and null rather than omitted, so one consumer can read either
            // protocol's answer without branching.
            feeIsDynamic: false,
            liveLpFee: s3!.fee,
            tickSpacing: v3!.tick_spacing,
            tick,
            hooks: null,
            hookLabel: null,
            liquidity: liquidity.toString(),
            unlocked: s3!.unlocked,
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
