import type { Address, Hex } from 'viem';
import { getClient } from '../../config/chain.js';
import { V3 } from '../../config/addresses.js';
import { V3_POOL_CREATED_EVENT } from '../abi.js';
import { getDb } from '../db/index.js';
import { classifyPool } from './classify.js';
import { stockTokenMap } from '../registry/stockTokens.js';

export interface V3PoolRow {
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  initBlock: number;
  initTx: Hex;
}

/**
 * v3 pool discovery. The factory emits PoolCreated for every pool it makes, so
 * this is the v3 equivalent of PoolManager.Initialize -- and it exists for the
 * same reason the v4 indexer is hook-agnostic: whoever deploys the pool, the
 * factory sees it.
 */
export async function fetchV3PoolsRange(fromBlock: bigint, toBlock: bigint): Promise<V3PoolRow[]> {
  const logs = await getClient().getLogs({
    address: V3.factory as Address,
    event: V3_POOL_CREATED_EVENT,
    fromBlock,
    toBlock,
  });
  return logs.map((l) => ({
    address: l.args.pool!,
    token0: l.args.token0!,
    token1: l.args.token1!,
    fee: Number(l.args.fee!),
    tickSpacing: Number(l.args.tickSpacing!),
    initBlock: Number(l.blockNumber),
    initTx: l.transactionHash!,
  }));
}

export function saveV3Pools(pools: V3PoolRow[]): { saved: number; stockPaired: number } {
  if (pools.length === 0) return { saved: 0, stockPaired: 0 };
  const db = getDb();
  const stockMap = stockTokenMap();
  const stmt = db.prepare(
    `INSERT INTO pools_v3 (address, token0, token1, fee, tick_spacing, init_block, init_tx,
                           stock_side, stock_symbol, paired_token, quote_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(address) DO NOTHING`,
  );

  let stockPaired = 0;
  db.exec('BEGIN');
  try {
    for (const p of pools) {
      const c = classifyPool(p.token0, p.token1, stockMap);
      if (c.quoteKind === 'stock') stockPaired++;
      stmt.run(
        p.address.toLowerCase(), p.token0.toLowerCase(), p.token1.toLowerCase(),
        p.fee, p.tickSpacing, p.initBlock, p.initTx,
        c.stockSide, c.stockSymbol, c.pairedToken, c.quoteKind,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { saved: pools.length, stockPaired };
}
