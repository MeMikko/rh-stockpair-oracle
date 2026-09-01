import { describe, it, expect } from 'vitest';
import { decodeAbiParameters, type Hex } from 'viem';
import { encodeV4SwapInput } from '../src/swap/encode.js';

/**
 * Byte-level check against a real Robinhood Chain swap.
 *
 * tx 0x30d6b2e6a8ac32151d0a88cf75c95db4e4d50ea4f275b7aafa198e68dc62d58a called
 * UniversalRouter 0x8876..0904 with commands 0x10 (V4_SWAP) and actions
 * 0x060c0f. The params blob below is copied verbatim from that transaction. If
 * our encoder reproduces it byte for byte from the same inputs, the single-hop
 * encoding on this chain is standard and the calldata we hand a signer is safe.
 */
const ONCHAIN_BLOB =
  '0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e197047f40d6f53462751909a10341f709d679b5000000000000000000000000000000000000000000000000000000000000006400000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000921099631565e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000000000000000000000000' as Hex;

describe('encodeV4SwapInput', () => {
  it('reproduces a real on-chain SWAP_EXACT_IN_SINGLE byte for byte', () => {
    const encoded = encodeV4SwapInput({
      poolKey: {
        currency0: '0x0000000000000000000000000000000000000000',
        currency1: '0xE197047f40d6f53462751909A10341F709D679b5',
        fee: 100,
        tickSpacing: 1,
        hooks: '0x0000000000000000000000000000000000000000',
      },
      zeroForOne: true,
      amountIn: 41113597578143200n,
      amountOutMinimum: 0n,
    });

    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }], encoded,
    ) as [Hex, Hex[]];

    // Same action triple the live transaction used.
    expect(actions).toBe('0x060c0f');
    expect(params).toHaveLength(3);
    expect(params[0]!.toLowerCase()).toBe(ONCHAIN_BLOB.toLowerCase());
  });

  it('puts currencyIn on SETTLE_ALL and currencyOut on TAKE_ALL, not the reverse', () => {
    const key = {
      currency0: '0x1111111111111111111111111111111111111111',
      currency1: '0x2222222222222222222222222222222222222222',
      fee: 3000, tickSpacing: 60,
      hooks: '0x0000000000000000000000000000000000000000',
    } as const;
    const [, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      encodeV4SwapInput({ poolKey: key, zeroForOne: false, amountIn: 5n, amountOutMinimum: 4n }),
    ) as [Hex, Hex[]];

    const [settleCur, settleAmt] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!);
    const [takeCur, takeAmt] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!);

    // zeroForOne=false means currency1 goes in and currency0 comes out.
    expect(settleCur.toLowerCase()).toBe(key.currency1);
    expect(takeCur.toLowerCase()).toBe(key.currency0);
    expect(settleAmt).toBe(5n);
    expect(takeAmt).toBe(4n);
  });
});
