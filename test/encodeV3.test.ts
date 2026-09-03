import { describe, it, expect } from 'vitest';
import { decodeFunctionData, getAddress, toFunctionSelector, type Hex } from 'viem';
import { encodeV3Swap, encodeV3Approval } from '../src/swap/encodeV3.js';
import { V3_SWAP_ROUTER_01_ABI, V3_SWAP_ROUTER_02_ABI, ERC20_APPROVE_ABI } from '../src/abi.js';

/**
 * The v3 calldata, decoded back.
 *
 * Encoding is exactly the kind of code that is confidently wrong: it produces
 * bytes either way, and the difference between a swap and a call the contract
 * does not have is four bytes at the front. So every case here decodes what was
 * built rather than comparing it to a string someone typed.
 */

// Checksummed, because that is what viem hands back when the calldata is
// decoded -- comparing against a lowercase literal would fail on casing and
// say nothing about the encoding.
const ROUTER = getAddress('0xcaf681a66d020601342297493863e78c959e5cb2');
const USDG = getAddress('0x5fc5360d0400a0fd4f2af552add042d716f1d168');
const NVDA = getAddress('0x1111111111111111111111111111111111111111');
const ME = getAddress('0x2222222222222222222222222222222222222222');

const plan = {
  tokenIn: USDG,
  tokenOut: NVDA,
  fee: 10_000,
  recipient: ME,
  amountIn: 1_000_000n,
  amountOutMinimum: 4_200n,
  deadline: 1_800_000_000n,
};

describe('SwapRouter02', () => {
  const built = encodeV3Swap(ROUTER, plan, 'swap-router-02');

  /**
   * The deadline is the one protection a caller cannot add after the fact, and
   * SwapRouter02 dropped it from the params struct — so the swap is wrapped in
   * the multicall overload that carries one.
   */
  it('wraps the swap in multicall(deadline, …)', () => {
    expect(built.data.slice(0, 10)).toBe(
      toFunctionSelector('function multicall(uint256,bytes[])').slice(0, 10),
    );
    expect(built.encoding).toMatch(/multicall/);

    const outer = decodeFunctionData({ abi: V3_SWAP_ROUTER_02_ABI, data: built.data });
    expect(outer.functionName).toBe('multicall');
    const [deadline, calls] = outer.args as [bigint, Hex[]];
    expect(deadline).toBe(plan.deadline);
    expect(calls).toHaveLength(1);
  });

  it('carries the swap the quoter priced, with the quoted min-out', () => {
    const [, calls] = decodeFunctionData({ abi: V3_SWAP_ROUTER_02_ABI, data: built.data })
      .args as [bigint, Hex[]];
    const inner = decodeFunctionData({ abi: V3_SWAP_ROUTER_02_ABI, data: calls[0]! });
    expect(inner.functionName).toBe('exactInputSingle');
    expect(inner.args[0]).toMatchObject({
      tokenIn: USDG,
      tokenOut: NVDA,
      fee: 10_000,
      recipient: ME,
      amountIn: 1_000_000n,
      amountOutMinimum: 4_200n,
      // No price limit: the min-out is the protection, and it was quoted.
      sqrtPriceLimitX96: 0n,
    });
  });

  it('sends no value, because a v3 input is an ERC-20 rather than native', () => {
    expect(built.value).toBe('0');
  });
});

describe('SwapRouter01', () => {
  const built = encodeV3Swap(ROUTER, plan, 'swap-router-01');

  /**
   * The two routers differ by one struct field, which changes the selector.
   * Calldata for one is not slightly wrong on the other — it is a function it
   * does not have.
   */
  it('is a different call from the 02 encoding', () => {
    expect(built.data.slice(0, 10)).not.toBe(
      encodeV3Swap(ROUTER, plan, 'swap-router-02').data.slice(0, 10),
    );
    expect(built.encoding).not.toMatch(/multicall/);
  });

  it('carries the deadline inside the params instead', () => {
    const decoded = decodeFunctionData({ abi: V3_SWAP_ROUTER_01_ABI, data: built.data });
    expect(decoded.functionName).toBe('exactInputSingle');
    expect(decoded.args[0]).toMatchObject({
      deadline: plan.deadline,
      amountOutMinimum: 4_200n,
      recipient: ME,
    });
  });
});

describe('the approval', () => {
  const approval = encodeV3Approval(USDG, ROUTER, 1_000_000n);

  /** v3 pulls from the router itself: no Permit2, and no second approval. */
  it('approves the router directly', () => {
    expect(approval.spender).toBe(ROUTER);
    expect(approval.standard).toBe('erc20-approve');
    expect(approval.to).toBe(USDG);
  });

  /** Scoped to the swap. An unlimited approval is not this service's to emit. */
  it('is scoped to exactly this swap, not unlimited', () => {
    const decoded = decodeFunctionData({ abi: ERC20_APPROVE_ABI, data: approval.data });
    expect(decoded.args).toEqual([ROUTER, 1_000_000n]);
    expect(approval.amount).toBe('1000000');
  });
});

describe('refusals', () => {
  it('will not encode a non-positive amount', () => {
    expect(() => encodeV3Swap(ROUTER, { ...plan, amountIn: 0n }, 'swap-router-02')).toThrow(
      RangeError,
    );
  });
});
