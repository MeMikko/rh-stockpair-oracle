import type { Address, Hex } from 'viem';
import { getLogsClient, env } from '../../config/chain.js';
import { V4 } from '../../config/addresses.js';
import { INITIALIZE_EVENT } from '../abi.js';
import { getDb } from '../db/index.js';
import { classifyPool } from './classify.js';
import { computePoolId } from './poolKey.js';
import { stockTokenMap } from '../registry/stockTokens.js';

export interface PoolRow {
  poolId: Hex;
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  initBlock: number;
  initTx: Hex;
  initSqrtPx: string;
  initTick: number;
}

/** Read Initialize events for a single block range. Caller owns chunking. */
export async function fetchInitializeRange(fromBlock: bigint, toBlock: bigint): Promise<PoolRow[]> {
  const logs = await getLogsClient().getLogs({
    address: V4.poolManager as Address,
    event: INITIALIZE_EVENT,
    fromBlock,
    toBlock,
  });

  return logs.map((l) => ({
    poolId: l.args.id!,
    currency0: l.args.currency0!,
    currency1: l.args.currency1!,
    fee: Number(l.args.fee!),
    tickSpacing: Number(l.args.tickSpacing!),
    hooks: l.args.hooks!,
    initBlock: Number(l.blockNumber),
    initTx: l.transactionHash!,
    initSqrtPx: String(l.args.sqrtPriceX96!),
    initTick: Number(l.args.tick!),
  }));
}

export function savePools(pools: PoolRow[]): { saved: number; stockPaired: number } {
  const db = getDb();
  const stockMap = stockTokenMap();
  const stmt = db.prepare(
    `INSERT INTO pools (pool_id, currency0, currency1, fee, tick_spacing, hooks,
                        init_block, init_tx, init_sqrt_px, init_tick,
                        stock_side, stock_symbol, paired_token, quote_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pool_id) DO NOTHING`,
  );

  if (pools.length === 0) return { saved: 0, stockPaired: 0 };

  let stockPaired = 0;
  db.exec('BEGIN');
  try {
  for (const p of pools) {
    const derived = computePoolId({
      currency0: p.currency0,
      currency1: p.currency1,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      hooks: p.hooks,
    });
    if (derived.toLowerCase() !== p.poolId.toLowerCase()) {
      throw new Error(`poolId mismatch for ${p.poolId}: derived ${derived}`);
    }

    const c = classifyPool(p.currency0, p.currency1, stockMap);
    if (c.quoteKind === 'stock') stockPaired++;
    stmt.run(
      p.poolId.toLowerCase(), p.currency0.toLowerCase(), p.currency1.toLowerCase(),
      p.fee, p.tickSpacing, p.hooks.toLowerCase(), p.initBlock, p.initTx,
      p.initSqrtPx, p.initTick, c.stockSide, c.stockSymbol, c.pairedToken, c.quoteKind,
    );
  }
    db.exec('COMMIT');
  } catch (err) {
    // A poolId mismatch is fatal on purpose -- a wrong PoolKey would produce
    // confidently wrong quotes -- but it must not leave the walker holding an
    // open transaction, or every later range fails for the wrong reason.
    db.exec('ROLLBACK');
    throw err;
  }
  return { saved: pools.length, stockPaired };
}

export const LOG_CHUNK = () => BigInt(env.logChunk);
