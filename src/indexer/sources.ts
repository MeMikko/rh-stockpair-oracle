import { decodeEventLog, toEventSelector, type Address, type Hex } from 'viem';
import { V3, V4 } from '../../config/addresses.js';
import { INITIALIZE_EVENT, V3_POOL_CREATED_EVENT } from '../abi.js';
import { bsGetLogs } from '../sources/blockscout.js';
import { fetchInitializeRange, type PoolRow } from './initialize.js';
import { fetchV3PoolsRange, type V3PoolRow } from './v3.js';

/**
 * Where a log-backed stream reads from.
 *
 * Two independent paths exist so that neither is a single point of failure:
 * the RPC is authoritative but is a paid dependency with its own limits, and
 * the explorer is free but is an index rather than the chain. Discovery may
 * come from either; anything that ends up in a quote is re-read from the RPC.
 */
export type LogSource = 'rpc' | 'blockscout';

export function parseSource(value: string | undefined, fallback: LogSource = 'rpc'): LogSource {
  const v = value?.trim().toLowerCase();
  if (v === 'blockscout' || v === 'bs') return 'blockscout';
  if (v === 'rpc') return 'rpc';
  return fallback;
}

/**
 * Event topic0 values. Derived from the same ABI items the RPC path uses
 * rather than pasted as literals, so the two sources can never end up
 * filtering on different events.
 */
export const TOPICS = {
  initialize: toEventSelector(INITIALIZE_EVENT),
  poolCreated: toEventSelector(V3_POOL_CREATED_EVENT),
} as const;

/**
 * Decode a Blockscout log with a viem event ABI.
 *
 * Blockscout returns the same topic/data split as eth_getLogs, so the decode
 * is identical; only the transport differs. A log that fails to decode is a
 * real problem (wrong topic, or an ABI drift) and is not silently dropped.
 */
function decode<T>(
  abi: typeof INITIALIZE_EVENT | typeof V3_POOL_CREATED_EVENT,
  log: { topics: Hex[]; data: Hex },
): T {
  const { args } = decodeEventLog({
    abi: [abi],
    topics: log.topics as [Hex, ...Hex[]],
    data: log.data,
  });
  return args as T;
}

interface InitializeArgs {
  id: Hex;
  currency0: Address;
  currency1: Address;
  fee: bigint;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  tick: number;
}

/** v4 pool discovery via the explorer rather than the RPC. */
export async function fetchInitializeRangeBs(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<PoolRow[]> {
  const logs = await bsGetLogs(V4.poolManager as Address, TOPICS.initialize, fromBlock, toBlock);
  return logs.map((l) => {
    const a = decode<InitializeArgs>(INITIALIZE_EVENT, l);
    return {
      poolId: a.id,
      currency0: a.currency0,
      currency1: a.currency1,
      fee: Number(a.fee),
      tickSpacing: Number(a.tickSpacing),
      hooks: a.hooks,
      initBlock: l.blockNumber,
      initTx: l.transactionHash,
      initSqrtPx: String(a.sqrtPriceX96),
      initTick: Number(a.tick),
    };
  });
}

interface PoolCreatedArgs {
  token0: Address;
  token1: Address;
  fee: bigint;
  tickSpacing: number;
  pool: Address;
}

/** v3 pool discovery via the explorer rather than the RPC. */
export async function fetchV3PoolsRangeBs(
  fromBlock: bigint,
  toBlock: bigint,
): Promise<V3PoolRow[]> {
  const logs = await bsGetLogs(V3.factory as Address, TOPICS.poolCreated, fromBlock, toBlock);
  return logs.map((l) => {
    const a = decode<PoolCreatedArgs>(V3_POOL_CREATED_EVENT, l);
    return {
      address: a.pool,
      token0: a.token0,
      token1: a.token1,
      fee: Number(a.fee),
      tickSpacing: Number(a.tickSpacing),
      initBlock: l.blockNumber,
      initTx: l.transactionHash,
    };
  });
}

export function initializeFetcher(source: LogSource) {
  return source === 'blockscout' ? fetchInitializeRangeBs : fetchInitializeRange;
}

export function v3PoolFetcher(source: LogSource) {
  return source === 'blockscout' ? fetchV3PoolsRangeBs : fetchV3PoolsRange;
}
