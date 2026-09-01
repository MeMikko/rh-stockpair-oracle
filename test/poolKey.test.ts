import { describe, it, expect } from 'vitest';
import { computePoolId } from '../src/indexer/poolKey.js';

describe('computePoolId', () => {
  it('reproduces a real on-chain v4 PoolId', () => {
    // Bankr/Doppler launch, tx 0x4cdf2f99...843f, verified against the
    // Initialize event emitted by PoolManager 0x8366..0951.
    const id = computePoolId({
      currency0: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      currency1: '0xe9fbF59a906c220b4fF0696cDF2faa306200cBA3',
      fee: 8388608,
      tickSpacing: 200,
      hooks: '0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544',
    });
    expect(id.toLowerCase()).toBe(
      '0x008a0b558ecee7c777411ea3ef616acc0def26f11db9b30035197f3f3c8d97cb',
    );
  });
});
