import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeErrorResult, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { decodeQuoterError, extractRevertData } from '../src/pricing/quoterErrors.js';

const wrap = (inner: Hex): Hex =>
  (toFunctionSelector('function UnexpectedRevertBytes(bytes)') +
    encodeAbiParameters([{ type: 'bytes' }], [inner]).slice(2)) as Hex;

describe('decodeQuoterError', () => {
  it('unwraps a hook revert and names the inner error', () => {
    const inner = encodeErrorResult({
      abi: parseAbi(['error NotEnoughLiquidity(bytes32 poolId)']),
      errorName: 'NotEnoughLiquidity',
      args: ['0x'.padEnd(66, 'a') as Hex],
    });
    const d = decodeQuoterError(wrap(inner));
    expect(d.wrapped).toBe(true);
    expect(d.reason).toContain('NotEnoughLiquidity');
  });

  it('unwraps a plain Error(string) from a hook', () => {
    const inner = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['not started'],
    });
    const d = decodeQuoterError(wrap(inner));
    expect(d.wrapped).toBe(true);
    expect(d.reason).toBe('Error("not started")');
  });

  it('reports an unknown inner selector without pretending to know it', () => {
    const d = decodeQuoterError(wrap('0xdeadbeef'));
    expect(d.wrapped).toBe(true);
    expect(d.reason).toContain('0xdeadbeef');
  });

  it('decodes an unwrapped top-level error', () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error PoolNotInitialized()']),
      errorName: 'PoolNotInitialized',
    });
    const d = decodeQuoterError(data);
    expect(d.wrapped).toBe(false);
    expect(d.reason).toBe('PoolNotInitialized');
  });

  it('handles empty revert data', () => {
    expect(decodeQuoterError('0x').reason).toBe('no_revert_data');
    expect(decodeQuoterError(undefined).reason).toBe('no_revert_data');
  });
});

describe('extractRevertData', () => {
  it('walks the viem cause chain to find raw data', () => {
    const err = { cause: { cause: { raw: '0x6190b2b0aaaaaaaa' } } };
    expect(extractRevertData(err)).toBe('0x6190b2b0aaaaaaaa');
  });

  it('returns undefined when there is nothing to find', () => {
    expect(extractRevertData(new Error('boom'))).toBeUndefined();
  });
});
