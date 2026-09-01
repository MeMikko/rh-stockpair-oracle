import { encodeAbiParameters, encodeFunctionData, type Address, type Hex } from 'viem';
import { UNIVERSAL_ROUTER_ABI } from '../abi.js';
import type { PoolKey } from '../indexer/poolKey.js';

/** UniversalRouter command byte. */
export const CMD_V4_SWAP = 0x10;

/** v4 router actions. */
export const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
export const ACT_SETTLE_ALL = 0x0c;
export const ACT_TAKE_ALL = 0x0f;

/**
 * Only the single-hop action is encoded here, deliberately.
 *
 * Multi-hop SWAP_EXACT_IN on this chain carries one extra dynamic field in
 * ExactInputParams that upstream v4-periphery does not have (it sits between
 * `path` and `amountIn`). Every live sample we decoded had it empty, so its
 * type cannot be read off the wire, and guessing it would produce calldata
 * that reverts or -- worse -- silently misprices. SWAP_EXACT_IN_SINGLE was
 * verified byte-for-byte against live transactions and is standard, and a
 * stock-paired quote is a single pool anyway.
 */
const EXACT_IN_SINGLE_PARAMS = [{
  type: 'tuple',
  components: [
    { name: 'poolKey', type: 'tuple', components: [
      { name: 'currency0', type: 'address' },
      { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickSpacing', type: 'int24' },
      { name: 'hooks', type: 'address' },
    ]},
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
}] as const;

const CURRENCY_AMOUNT = [{ type: 'address' }, { type: 'uint256' }] as const;

export interface SwapPlan {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  hookData?: Hex;
}

/** The v4 actions blob that goes inside the router's V4_SWAP input. */
export function encodeV4SwapInput(plan: SwapPlan): Hex {
  const actions = `0x${[ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL]
    .map((b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;

  const currencyIn = plan.zeroForOne ? plan.poolKey.currency0 : plan.poolKey.currency1;
  const currencyOut = plan.zeroForOne ? plan.poolKey.currency1 : plan.poolKey.currency0;

  const swapParams = encodeAbiParameters(EXACT_IN_SINGLE_PARAMS as never, [{
    poolKey: plan.poolKey,
    zeroForOne: plan.zeroForOne,
    amountIn: plan.amountIn,
    amountOutMinimum: plan.amountOutMinimum,
    hookData: plan.hookData ?? '0x',
  }] as never);

  const settle = encodeAbiParameters(CURRENCY_AMOUNT, [currencyIn, plan.amountIn]);
  const take = encodeAbiParameters(CURRENCY_AMOUNT, [currencyOut, plan.amountOutMinimum]);

  return encodeAbiParameters(
    [{ type: 'bytes' }, { type: 'bytes[]' }],
    [actions, [swapParams, settle, take]],
  );
}

export interface EncodedSwap {
  to: Address;
  data: Hex;
  value: string;
  commands: Hex;
  deadline: string;
}

/** Full UniversalRouter.execute calldata. Never broadcast by this service. */
export function encodeSwap(
  router: Address,
  plan: SwapPlan,
  deadline: bigint,
  nativeValue: bigint = 0n,
): EncodedSwap {
  const commands = `0x${CMD_V4_SWAP.toString(16).padStart(2, '0')}` as Hex;
  const input = encodeV4SwapInput(plan);
  return {
    to: router,
    data: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [commands, [input], deadline],
    }),
    value: String(nativeValue),
    commands,
    deadline: String(deadline),
  };
}
