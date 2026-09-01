import type { Address } from 'viem';
import { getClient } from '../../config/chain.js';
import { AGGREGATOR_V3_ABI } from '../abi.js';
import type { Feed } from '../registry/feeds.js';

export interface OracleRead {
  symbol: string;
  priceUsd: number;
  decimals: number;
  updatedAt: number;
  ageSeconds: number;
  stale: boolean;
  proxy: string;
}

/**
 * RH stock feeds publish on a 0.5% deviation threshold with an 86400s
 * heartbeat, so a multi-hour-old answer is entirely normal and "age > some
 * small number" is the wrong staleness test. We flag stale only past the
 * heartbeat, and let the caller weigh `ageSeconds` against session state.
 */
export async function readFeed(feed: Feed, now = Math.floor(Date.now() / 1000)): Promise<OracleRead> {
  const client = getClient();
  const [round, decimals] = await Promise.all([
    client.readContract({
      address: feed.proxyAddress as Address,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'latestRoundData',
    }),
    client.readContract({
      address: feed.proxyAddress as Address,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'decimals',
    }),
  ]);

  const answer = round[1];
  const updatedAt = Number(round[3]);
  const dec = Number(decimals);

  if (answer <= 0n) throw new Error(`feed ${feed.symbol} returned non-positive answer`);

  return {
    symbol: feed.symbol,
    priceUsd: Number(answer) / 10 ** dec,
    decimals: dec,
    updatedAt,
    ageSeconds: now - updatedAt,
    stale: now - updatedAt > feed.heartbeat,
    proxy: feed.proxyAddress,
  };
}
