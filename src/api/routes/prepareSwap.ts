import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { getDb } from '../../db/index.js';
import { ROUTER, DYNAMIC_FEE_FLAG, labelHook } from '../../../config/addresses.js';
import { tokenMeta } from '../../registry/tokenMeta.js';
import { readPoolState, priceFromSqrtX96 } from '../../pricing/poolState.js';
import { quoteExactIn, QuoterError } from '../../pricing/impact.js';
import { encodeSwap } from '../../swap/encode.js';
import { applySlippage, MAX_SLIPPAGE_BPS } from '../../swap/slippage.js';
import { estimateComponents } from '../../pricing/gas.js';

interface PoolRecord {
  pool_id: string; currency0: string; currency1: string; fee: number;
  tick_spacing: number; hooks: string; stock_side: number | null;
  stock_symbol: string | null; quote_kind: string;
}

const NATIVE = '0x0000000000000000000000000000000000000000';

/**
 * Builds ready-to-sign calldata. It never signs and never broadcasts, holds no
 * keys, and takes no custody -- the caller signs or discards.
 */
export function registerPrepareSwap(app: FastifyInstance): void {
  app.post('/prepare-swap', async (req, reply) => {
    const body = (req.body ?? {}) as {
      pool?: string; amountIn?: string; zeroForOne?: boolean;
      slippageBps?: number; deadlineSeconds?: number; recipient?: string;
    };

    if (!body.pool) return reply.code(400).send({ error: 'pool required (v4 poolId)' });
    if (!body.amountIn) return reply.code(400).send({ error: 'amountIn required (base units, string)' });
    if (typeof body.zeroForOne !== 'boolean') {
      return reply.code(400).send({ error: 'zeroForOne required (bool): true sells currency0' });
    }

    const slippageBps = body.slippageBps ?? 50;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
      return reply.code(400).send({
        error: `slippageBps must be an integer between 0 and ${MAX_SLIPPAGE_BPS}`,
      });
    }

    const key = body.pool.toLowerCase();
    const pool = getDb().prepare('SELECT * FROM pools WHERE pool_id = ?')
      .get(key) as PoolRecord | undefined;
    if (!pool) {
      // A v3 pool is indexed and quotable, and still cannot be encoded here:
      // v3 swaps go through SwapRouter02 with a plain ERC-20 approval, not
      // through the UniversalRouter with Permit2, so the calldata is a
      // different shape rather than a different address. Saying so is better
      // than a bare 404 that reads as "unknown pool" for a pool /quote just
      // answered about.
      const v3 = getDb().prepare('SELECT address FROM pools_v3 WHERE address = ?').get(key) as
        | { address: string }
        | undefined;
      if (v3) {
        return reply.code(501).send({
          error: 'that is a v3 pool; calldata for v3 is not implemented',
          poolId: body.pool,
          protocol: 'v3',
          quotable: `GET /quote?pool=${v3.address}`,
          note:
            'v3 routes through SwapRouter02 with an ERC-20 approval rather than the ' +
            'UniversalRouter with Permit2. Nothing here will emit half-correct calldata: ' +
            'quote it here and build the swap with a v3 SDK, or ask for v3 support.',
        });
      }
      return reply.code(404).send({ error: 'pool not indexed', poolId: body.pool });
    }

    let amountIn: bigint;
    try {
      amountIn = BigInt(body.amountIn);
      if (amountIn <= 0n) throw new Error('non-positive');
    } catch {
      return reply.code(400).send({ error: 'amountIn must be a positive integer string in base units' });
    }

    const poolKey = {
      currency0: pool.currency0 as Address, currency1: pool.currency1 as Address,
      fee: pool.fee, tickSpacing: pool.tick_spacing, hooks: pool.hooks as Address,
    };
    const currencyIn = body.zeroForOne ? pool.currency0 : pool.currency1;
    const currencyOut = body.zeroForOne ? pool.currency1 : pool.currency0;

    const [metaIn, metaOut] = await Promise.all([tokenMeta(currencyIn), tokenMeta(currencyOut)]);
    const state = await readPoolState(pool.pool_id as Hex, pool.fee);
    const spot = priceFromSqrtX96(state.sqrtPriceX96, metaIn.decimals, metaOut.decimals);

    // min-out comes from the on-chain quoter, never from spot: for these pools
    // the hook and the live dynamic fee both move the real output.
    let quoted;
    try {
      quoted = await quoteExactIn(
        poolKey, body.zeroForOne, amountIn, spot, metaIn.decimals, metaOut.decimals,
      );
    } catch (err) {
      const reason = err instanceof QuoterError ? err.reason : (err as Error).message.split('\n')[0];
      return reply.code(422).send({
        error: 'cannot quote this swap; refusing to emit calldata without a min-out',
        reason,
        fromHook: err instanceof QuoterError ? err.fromHook : false,
        poolId: pool.pool_id,
      });
    }

    const minOut = applySlippage(quoted.amountOut, slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (body.deadlineSeconds ?? 900));
    const isNativeIn = currencyIn.toLowerCase() === NATIVE;

    const swap = encodeSwap(
      ROUTER.universalRouter as Address,
      { poolKey, zeroForOne: body.zeroForOne, amountIn, amountOutMinimum: minOut },
      deadline,
      isNativeIn ? amountIn : 0n,
    );

    let gas = null;
    let gasError: string | null = null;
    try {
      gas = await estimateComponents(swap.to, swap.data, body.recipient as Address | undefined);
    } catch (err) {
      gasError = ((err as Error).message.split('\n')[0] ?? 'gas estimate failed').slice(0, 220);
    }

    return {
      chainId: 4663,
      poolId: pool.pool_id,
      transaction: { to: swap.to, data: swap.data, value: swap.value },
      swap: {
        currencyIn, currencyOut,
        decimalsIn: metaIn.decimals, decimalsOut: metaOut.decimals,
        amountIn: amountIn.toString(),
        quotedOut: quoted.amountOut.toString(),
        minOut: minOut.toString(),
        slippageBps,
        priceImpact: quoted.priceImpact,
        deadline: swap.deadline,
      },
      pool: {
        fee: pool.fee, feeIsDynamic: pool.fee === DYNAMIC_FEE_FLAG,
        liveLpFee: state.lpFee, hooks: pool.hooks, hookLabel: labelHook(pool.hooks),
        stockSymbol: pool.stock_symbol,
      },
      // ERC-20 inputs must be approved to Permit2, and Permit2 must be
      // authorised for the router. Native input needs neither.
      approvals: isNativeIn ? [] : [
        { token: currencyIn, spender: ROUTER.permit2, standard: 'erc20-approve',
          note: 'approve Permit2 once per token' },
        { token: currencyIn, spender: ROUTER.universalRouter, standard: 'permit2-approve',
          note: 'Permit2.approve(token, universalRouter, amount, expiration)' },
      ],
      gas, gasError,
      disclaimer: 'Unsigned calldata. This service never signs, never broadcasts, and never holds your funds. Verify min-out before signing.',
      generatedAt: new Date().toISOString(),
    };
  });
}
