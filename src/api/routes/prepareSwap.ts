import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Address, Hex } from 'viem';
import { getDb } from '../../db/index.js';
import { ROUTER, DYNAMIC_FEE_FLAG, labelHook } from '../../../config/addresses.js';
import { tokenMeta } from '../../registry/tokenMeta.js';
import { readPoolState, priceFromSqrtX96 } from '../../pricing/poolState.js';
import { quoteExactIn, QuoterError } from '../../pricing/impact.js';
import { encodeSwap } from '../../swap/encode.js';
import { encodeV3Approval, encodeV3Swap } from '../../swap/encodeV3.js';
import { RouterVariantUnknown, v3RouterFacts } from '../../swap/routerV3.js';
import { readV3PoolState } from '../../pricing/poolStateV3.js';
import { quoteExactInV3 } from '../../pricing/impactV3.js';
import { applySlippage, MAX_SLIPPAGE_BPS } from '../../swap/slippage.js';
import { estimateComponents } from '../../pricing/gas.js';

interface PoolRecord {
  pool_id: string; currency0: string; currency1: string; fee: number;
  tick_spacing: number; hooks: string; stock_side: number | null;
  stock_symbol: string | null; quote_kind: string;
}

interface V3PoolRecord {
  address: string; token0: string; token1: string; fee: number;
  tick_spacing: number; stock_symbol: string | null; quote_kind: string;
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

    if (!body.pool) {
      return reply.code(400).send({
        error: 'pool required: a v4 poolId (32 bytes) or a v3 pool address',
        find: 'GET /pools?symbol=NVDA lists both, with their identifiers',
      });
    }
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
      const v3 = getDb().prepare('SELECT * FROM pools_v3 WHERE address = ?').get(key) as
        | V3PoolRecord
        | undefined;
      if (v3) return prepareV3Swap(reply, req, v3, body, slippageBps);
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

/**
 * The v3 half of `/prepare-swap`.
 *
 * v3 answered 501 here until now, which was honest about a real difference:
 * v4 goes through the UniversalRouter with Permit2 and an actions blob, v3
 * calls its router directly with a plain ERC-20 approval and a flat struct.
 * Different calldata, not a different address — and with four of the five
 * largest stock-paired pools on v3, "quotable but not buildable" was the gap
 * that mattered.
 *
 * Three things are established rather than assumed, because each is a way to
 * emit calldata that looks right and is not:
 *
 *  - **Which router.** SwapRouter and SwapRouter02 differ by one struct field,
 *    so the selectors differ. `v3RouterFacts()` reads the chain.
 *  - **The fee.** Taken from the pool's own `fee()` rather than the indexed
 *    copy: the router routes by (tokenIn, tokenOut, fee), so a stale fee sends
 *    the swap to a different pool than the one that was quoted.
 *  - **The min-out.** From the quoter, as on v4. No quote, no calldata.
 */
async function prepareV3Swap(
  reply: FastifyReply,
  req: FastifyRequest,
  v3: V3PoolRecord,
  body: {
    amountIn?: string; zeroForOne?: boolean; deadlineSeconds?: number; recipient?: string;
  },
  slippageBps: number,
) {
  let amountIn: bigint;
  try {
    amountIn = BigInt(body.amountIn as string);
    if (amountIn <= 0n) throw new Error('non-positive');
  } catch {
    return reply.code(400).send({ error: 'amountIn must be a positive integer string in base units' });
  }

  // v3 names the recipient in the calldata; there is no msg.sender default that
  // holds across both router variants. Defaulting it to anything would be
  // choosing where someone else's tokens land.
  const recipient = body.recipient?.trim();
  if (!recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return reply.code(400).send({
      error: 'recipient required for a v3 swap: the address that receives the output',
      why:
        'v3 carries the recipient in the calldata rather than defaulting to the sender, ' +
        'and this service will not pick an address for you.',
    });
  }

  let router;
  try {
    router = await v3RouterFacts();
  } catch (err) {
    // Not knowing which router is deployed is not the same as knowing it is the
    // old one. Emitting calldata on a guess is the failure this whole route
    // exists to avoid.
    if (err instanceof RouterVariantUnknown) {
      return reply.code(503).send({
        error: 'cannot establish which v3 router is deployed; refusing to guess the calldata shape',
        detail: err.message.slice(0, 200),
        hint: 'set V3_ROUTER_VARIANT=swap-router-02 (or swap-router-01) to pin it',
      });
    }
    throw err;
  }

  const tokenIn = (body.zeroForOne ? v3.token0 : v3.token1) as Address;
  const tokenOut = (body.zeroForOne ? v3.token1 : v3.token0) as Address;

  const [metaIn, metaOut] = await Promise.all([tokenMeta(tokenIn), tokenMeta(tokenOut)]);
  const state = await readV3PoolState(v3.address as Address);
  const spot = priceFromSqrtX96(
    state.sqrtPriceX96,
    body.zeroForOne ? metaIn.decimals : metaOut.decimals,
    body.zeroForOne ? metaOut.decimals : metaIn.decimals,
  );

  let quoted;
  try {
    quoted = await quoteExactInV3({
      tokenIn, tokenOut,
      // The live fee, because it is what the router routes by.
      fee: state.fee,
      amountIn,
      spotPrice: spot,
      zeroForOne: body.zeroForOne as boolean,
      decimalsIn: metaIn.decimals,
      decimalsOut: metaOut.decimals,
    });
  } catch (err) {
    const reason = err instanceof QuoterError ? err.reason : (err as Error).message.split('\n')[0];
    return reply.code(422).send({
      error: 'cannot quote this swap; refusing to emit calldata without a min-out',
      reason,
      protocol: 'v3',
      poolId: v3.address,
    });
  }

  const minOut = applySlippage(quoted.amountOut, slippageBps);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (body.deadlineSeconds ?? 900));

  const swap = encodeV3Swap(
    router.address,
    {
      tokenIn, tokenOut,
      fee: state.fee,
      recipient: recipient as Address,
      amountIn,
      amountOutMinimum: minOut,
      deadline,
    },
    router.variant,
  );

  let gas = null;
  let gasError: string | null = null;
  try {
    gas = await estimateComponents(swap.to, swap.data, recipient as Address);
  } catch (err) {
    // Expected before the approval exists: the estimate reverts on the pull,
    // not on the swap. Reported rather than hidden, exactly as on v4.
    gasError = ((err as Error).message.split('\n')[0] ?? 'gas estimate failed').slice(0, 220);
  }

  req.log.info(`prepared v3 swap on ${v3.address} via ${router.variant} (${router.source})`);

  return {
    chainId: 4663,
    poolId: v3.address,
    protocol: 'v3',
    transaction: { to: swap.to, data: swap.data, value: swap.value },
    swap: {
      currencyIn: tokenIn, currencyOut: tokenOut,
      decimalsIn: metaIn.decimals, decimalsOut: metaOut.decimals,
      amountIn: amountIn.toString(),
      quotedOut: quoted.amountOut.toString(),
      minOut: minOut.toString(),
      slippageBps,
      priceImpact: quoted.priceImpact,
      ticksCrossed: quoted.ticksCrossed ?? null,
      recipient,
      deadline: swap.deadline,
      encoding: swap.encoding,
    },
    pool: {
      address: v3.address,
      fee: state.fee,
      // Neither exists on v3. Reported as such rather than omitted, so one
      // consumer can read either protocol's answer without branching.
      feeIsDynamic: false,
      liveLpFee: state.fee,
      hooks: null,
      hookLabel: null,
      stockSymbol: v3.stock_symbol,
      unlocked: state.unlocked,
    },
    router: {
      address: router.address,
      variant: router.variant,
      // `chain` means the probe read it; `config` means someone asserted it.
      variantSource: router.source,
      deadlineIn: router.deadlineIn,
    },
    approvals: [encodeV3Approval(tokenIn, router.address, amountIn)],
    gas, gasError,
    disclaimer: 'Unsigned calldata. This service never signs, never broadcasts, and never holds your funds. Verify min-out before signing.',
    generatedAt: new Date().toISOString(),
  };
}
