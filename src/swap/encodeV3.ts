import { encodeFunctionData, type Address, type Hex } from 'viem';
import { ERC20_APPROVE_ABI, V3_SWAP_ROUTER_01_ABI, V3_SWAP_ROUTER_02_ABI } from '../abi.js';
import type { V3RouterVariant } from './routerV3.js';

/**
 * Calldata for a single-hop v3 swap.
 *
 * Deliberately a different file from the v4 encoder rather than a branch inside
 * it, because almost nothing is shared. v4 goes through the UniversalRouter
 * with Permit2 and an actions blob; v3 calls the router directly with a plain
 * ERC-20 approval and a flat struct. The only thing they have in common is that
 * neither is ever signed or broadcast here.
 *
 * Exact-input single-hop only, matching what `/quote` prices. Multi-hop would
 * need a path encoding and a route the quoter never simulated, and calldata for
 * a swap nobody quoted is exactly the min-out-less transaction this service
 * refuses to emit.
 */

/** No price limit: the min-out is the protection, and it is quoted, not guessed. */
const NO_PRICE_LIMIT = 0n;

export interface V3SwapPlan {
  tokenIn: Address;
  tokenOut: Address;
  /** The pool's fee tier, in hundredths of a bip. Read live off the pool. */
  fee: number;
  /** Where the output goes. v3 names it explicitly; there is no msg.sender default. */
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
}

export interface EncodedV3Swap {
  to: Address;
  data: Hex;
  value: string;
  /** What was built, named exactly, so a reader can check it rather than trust it. */
  encoding: string;
  deadline: string;
}

export function encodeV3Swap(
  router: Address,
  plan: V3SwapPlan,
  variant: V3RouterVariant,
): EncodedV3Swap {
  if (plan.amountIn <= 0n) throw new RangeError('amountIn must be positive');

  if (variant === 'swap-router-01') {
    // The original router carries the deadline in the struct, so one call is
    // the whole transaction.
    return {
      to: router,
      data: encodeFunctionData({
        abi: V3_SWAP_ROUTER_01_ABI,
        functionName: 'exactInputSingle',
        args: [
          {
            tokenIn: plan.tokenIn,
            tokenOut: plan.tokenOut,
            fee: plan.fee,
            recipient: plan.recipient,
            deadline: plan.deadline,
            amountIn: plan.amountIn,
            amountOutMinimum: plan.amountOutMinimum,
            sqrtPriceLimitX96: NO_PRICE_LIMIT,
          },
        ],
      }),
      value: '0',
      encoding: 'SwapRouter.exactInputSingle(params with deadline)',
      deadline: String(plan.deadline),
    };
  }

  // SwapRouter02 dropped the deadline from the struct. Wrapping the swap in
  // `multicall(deadline, [swap])` is how the deadline is enforced there --
  // the same shape Uniswap's own interface emits. Sending the bare
  // exactInputSingle would work and would silently have no deadline at all,
  // which is the one protection a caller cannot add afterwards.
  const swap = encodeFunctionData({
    abi: V3_SWAP_ROUTER_02_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: plan.tokenIn,
        tokenOut: plan.tokenOut,
        fee: plan.fee,
        recipient: plan.recipient,
        amountIn: plan.amountIn,
        amountOutMinimum: plan.amountOutMinimum,
        sqrtPriceLimitX96: NO_PRICE_LIMIT,
      },
    ],
  });

  return {
    to: router,
    data: encodeFunctionData({
      abi: V3_SWAP_ROUTER_02_ABI,
      functionName: 'multicall',
      args: [plan.deadline, [swap]],
    }),
    value: '0',
    encoding: 'SwapRouter02.multicall(deadline, [exactInputSingle])',
    deadline: String(plan.deadline),
  };
}

/**
 * The approval a v3 swap needs, encoded rather than described.
 *
 * v3 pulls the input with `transferFrom` straight from the router, so the
 * caller approves the router itself — no Permit2, and no second approval of
 * Permit2 to a router. Exactly `amountIn` rather than the unlimited approval a
 * convenience-first integration would emit: this service's whole posture is
 * that a signer should be able to see what they are authorising.
 */
export function encodeV3Approval(token: Address, router: Address, amountIn: bigint) {
  return {
    token,
    spender: router,
    standard: 'erc20-approve' as const,
    amount: amountIn.toString(),
    to: token,
    data: encodeFunctionData({
      abi: ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [router, amountIn],
    }),
    note:
      'v3 pulls the input from the router itself, so this is the only approval needed. ' +
      'Scoped to this swap rather than unlimited.',
  };
}
