import { zeroAddress, type Address } from 'viem';
import { getClient } from '../../config/chain.js';
import { TOKENS } from '../../config/addresses.js';
import { ERC20_ABI } from '../abi.js';
import { getDb } from '../db/index.js';

export interface TokenMeta {
  decimals: number;
  /** registry | builtin | rpc | assumed. 'assumed' means decimals() reverted. */
  source: string;
}

const memo = new Map<string, TokenMeta>();

function put(address: string, decimals: number, source: string, symbol: string | null = null): TokenMeta {
  const key = address.toLowerCase();
  getDb()
    .prepare(
      `INSERT INTO token_meta (address, symbol, decimals, source, synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET symbol=COALESCE(excluded.symbol, token_meta.symbol),
                                          decimals=excluded.decimals, source=excluded.source`,
    )
    .run(key, symbol, decimals, source, Date.now());
  const meta = { decimals, source };
  memo.set(key, meta);
  return meta;
}

/** Seed from the stock registry (all 18) plus the two core tokens. */
export function seedTokenMeta(stock: { address: string; symbol: string; decimals: number }[]): void {
  const db = getDb();
  db.exec('BEGIN');
  for (const t of stock) put(t.address, t.decimals, 'registry', t.symbol);
  put(TOKENS.weth, 18, 'builtin', 'WETH');
  put(TOKENS.usdg, 6, 'builtin', 'USDG');
  put(zeroAddress, 18, 'builtin', 'ETH'); // v4 uses address(0) for native
  db.exec('COMMIT');
}

/**
 * Decimals for any token, cached forever. Only genuinely unknown tokens --
 * memecoins from a launch we have not seen before -- reach the RPC, and the
 * answer is persisted so they reach it once.
 *
 * Not every currency in a v4 pool is a well-behaved ERC-20: launchpad tokens
 * turn up whose decimals() reverts. Those are recorded as an 18-decimal
 * assumption rather than failing the request, and /quote reports the
 * assumption so nobody mistakes it for a measured value.
 */
export async function tokenMeta(address: string): Promise<TokenMeta> {
  const key = address.toLowerCase();
  const hit = memo.get(key);
  if (hit) return hit;

  const row = getDb()
    .prepare('SELECT decimals, source FROM token_meta WHERE address = ?')
    .get(key) as { decimals: number; source: string } | undefined;
  if (row) {
    const meta = { decimals: Number(row.decimals), source: String(row.source) };
    memo.set(key, meta);
    return meta;
  }

  try {
    const d = Number(
      await getClient().readContract({ address: address as Address, abi: ERC20_ABI, functionName: 'decimals' }),
    );
    return put(key, d, 'rpc');
  } catch {
    return put(key, 18, 'assumed');
  }
}

export async function tokenDecimals(address: string): Promise<number> {
  return (await tokenMeta(address)).decimals;
}
