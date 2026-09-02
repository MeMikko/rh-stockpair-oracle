import type { Address } from 'viem';
import { getDb } from '../src/db/index.js';
import { bsEnv, bsTokenInfo } from '../src/sources/blockscout.js';

/**
 * Pull holder counts and token metadata from the explorer.
 *
 * A holder count is not chain state -- it is an index over transfer history --
 * so no RPC call returns it and this is the only way to have it at all. It is
 * stored away from the pricing path: useful for judging whether a pool has a
 * real audience, never an input to a quote.
 *
 *   npm run holders:sync                # every stock token + every paired token
 *   npm run holders:sync -- --stock     # stock tokens only
 */
const flag = (n: string) => process.argv.includes(`--${n}`);
const db = getDb();

const stock = (
  db.prepare('SELECT address FROM stock_tokens').all() as unknown as Array<{ address: string }>
).map((r) => r.address);

const paired = flag('stock')
  ? []
  : (
      db
        .prepare(
          `SELECT DISTINCT paired_token AS address FROM pools
            WHERE quote_kind = 'stock' AND paired_token IS NOT NULL
              AND paired_token != '0x0000000000000000000000000000000000000000'
           UNION
           SELECT DISTINCT paired_token AS address FROM pools_v3
            WHERE quote_kind = 'stock' AND paired_token IS NOT NULL
              AND paired_token != '0x0000000000000000000000000000000000000000'`,
        )
        .all() as unknown as Array<{ address: string }>
    ).map((r) => r.address);

const targets = [...new Set([...stock, ...paired])];
console.log(`holders | ${targets.length} tokens (${stock.length} stock, ${paired.length} paired)`);
console.log(`  ${bsEnv.baseUrl}${bsEnv.apiKey ? ' (keyed)' : ' (no key -- slower)'}\n`);

const stmt = db.prepare(
  `INSERT INTO token_explorer (address, symbol, name, decimals, holders, total_supply,
                               exchange_rate, synced_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(address) DO UPDATE SET
     symbol = excluded.symbol, name = excluded.name, decimals = excluded.decimals,
     holders = excluded.holders, total_supply = excluded.total_supply,
     exchange_rate = excluded.exchange_rate, synced_at = excluded.synced_at`,
);

let ok = 0;
let missing = 0;
for (const [i, addr] of targets.entries()) {
  const info = await bsTokenInfo(addr as Address);
  if (!info) {
    missing++;
  } else {
    stmt.run(
      addr.toLowerCase(), info.symbol, info.name, info.decimals, info.holders,
      info.totalSupply, info.exchangeRate, Date.now(),
    );
    ok++;
  }
  if ((i + 1) % 25 === 0 || i === targets.length - 1) {
    console.log(`  ${i + 1}/${targets.length} | ${ok} stored | ${missing} not indexed`);
  }
}

console.log(`\n${ok} tokens stored, ${missing} not found on the explorer`);

const top = db
  .prepare(
    `SELECT e.symbol, e.holders, e.exchange_rate
       FROM token_explorer e
      WHERE e.holders IS NOT NULL
      ORDER BY e.holders DESC LIMIT 10`,
  )
  .all() as unknown as Array<{ symbol: string; holders: number; exchange_rate: number | null }>;

console.log('\nmost held');
for (const t of top) {
  console.log(
    `  ${(t.symbol ?? '?').padEnd(10)} ${String(t.holders).padStart(9)} holders` +
      `${t.exchange_rate ? `  $${t.exchange_rate}` : ''}`,
  );
}
