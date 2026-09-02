import { getClient, env, rpcHost } from '../config/chain.js';
import { bsEnv, BLOCKSCOUT_LOG_CAP } from '../src/sources/blockscout.js';
import { initializeFetcher, v3PoolFetcher } from '../src/indexer/sources.js';
import { walkLogs } from '../src/indexer/logWalker.js';
import { withRetry } from '../src/util/retry.js';

/**
 * Cross-check pool discovery between the RPC and the explorer.
 *
 * Two sources are only worth having if they are compared. An explorer indexes
 * the chain rather than being it, so it can lag, reorg differently, or drop
 * logs at a CDN edge; an RPC can silently truncate a range. Either failure
 * would show up as a pool count that is wrong in a published post, so the
 * difference is measured rather than assumed to be zero.
 *
 *   npm run crosscheck                    # last 200k blocks, v4
 *   npm run crosscheck -- --blocks=500000 --v3
 *   npm run crosscheck -- --from=52000000 --to=52100000
 */
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const which = flag('v3') ? 'v3' : 'v4';
const tip = await withRetry(() => getClient().getBlockNumber(), { label: 'blockNumber' });
const to = arg('to') ? BigInt(arg('to')!) : tip;
const from = arg('from')
  ? BigInt(arg('from')!)
  : to - BigInt(arg('blocks') ?? 200_000) + 1n;

console.log(
  `crosscheck ${which} | blocks ${from}-${to} (${to - from + 1n})\n` +
    `  rpc        ${rpcHost()}\n` +
    `  blockscout ${bsEnv.baseUrl}${bsEnv.apiKey ? ' (keyed)' : ' (no key)'}\n`,
);

interface Row {
  key: string;
  block: number;
  tx: string;
  detail: string;
}

/** Normalise both shapes to one comparable row. */
function toRows(which: 'v3' | 'v4', rows: unknown[]): Row[] {
  if (which === 'v4') {
    return (rows as Array<{ poolId: string; initBlock: number; initTx: string; currency0: string; currency1: string; fee: number; hooks: string }>).map((p) => ({
      key: p.poolId.toLowerCase(),
      block: p.initBlock,
      tx: p.initTx.toLowerCase(),
      detail: `${p.currency0.toLowerCase()}/${p.currency1.toLowerCase()} fee=${p.fee} hooks=${p.hooks.toLowerCase()}`,
    }));
  }
  return (rows as Array<{ address: string; initBlock: number; initTx: string; token0: string; token1: string; fee: number }>).map((p) => ({
    key: p.address.toLowerCase(),
    block: p.initBlock,
    tx: p.initTx.toLowerCase(),
    detail: `${p.token0.toLowerCase()}/${p.token1.toLowerCase()} fee=${p.fee}`,
  }));
}

async function collect(source: 'rpc' | 'blockscout'): Promise<Row[]> {
  const out: Row[] = [];
  const fetcher = which === 'v4' ? initializeFetcher(source) : v3PoolFetcher(source);
  const maxSpan =
    source === 'blockscout' ? BigInt(BLOCKSCOUT_LOG_CAP) * 10n : BigInt(env.logChunk);

  const started = Date.now();
  const res = await walkLogs({
    // A dedicated stream name so a cross-check can never move the real cursor.
    stream: `crosscheck:${which}:${source}`,
    fromBlock: from,
    toBlock: to,
    maxSpan,
    resume: false,
    fetch: fetcher as (f: bigint, t: bigint) => Promise<unknown[]>,
    save: (rows) => out.push(...toRows(which, rows)),
  });
  console.log(
    `  ${source.padEnd(11)} ${out.length} pools | ${res.ranges} ranges | ` +
      `${res.failures} failures | ${((Date.now() - started) / 1000).toFixed(1)}s` +
      `${res.complete ? '' : ' | INCOMPLETE'}`,
  );
  if (!res.complete) {
    console.error(`  ${source}: walk did not complete; the diff below is not conclusive.`);
    process.exitCode = 1;
  }
  return out;
}

const rpc = await collect('rpc');
const bs = await collect('blockscout');

const rpcMap = new Map(rpc.map((r) => [r.key, r]));
const bsMap = new Map(bs.map((r) => [r.key, r]));

const onlyRpc = rpc.filter((r) => !bsMap.has(r.key));
const onlyBs = bs.filter((r) => !rpcMap.has(r.key));
const mismatched = rpc
  .filter((r) => bsMap.has(r.key))
  .filter((r) => {
    const o = bsMap.get(r.key)!;
    return o.block !== r.block || o.tx !== r.tx || o.detail !== r.detail;
  });

console.log(`\n  agreed          ${rpc.length - onlyRpc.length}`);
console.log(`  only in rpc     ${onlyRpc.length}`);
console.log(`  only in bs      ${onlyBs.length}`);
console.log(`  field mismatch  ${mismatched.length}`);

const show = (label: string, rows: Row[]) => {
  if (rows.length === 0) return;
  console.log(`\n${label}:`);
  for (const r of rows.slice(0, 10)) console.log(`  ${r.key} @${r.block} ${r.detail}`);
  if (rows.length > 10) console.log(`  ... and ${rows.length - 10} more`);
};
show('only in rpc', onlyRpc);
show('only in blockscout', onlyBs);
for (const r of mismatched.slice(0, 10)) {
  const o = bsMap.get(r.key)!;
  console.log(`\nmismatch ${r.key}\n  rpc @${r.block} ${r.detail}\n  bs  @${o.block} ${o.detail}`);
}

if (onlyRpc.length || onlyBs.length || mismatched.length) {
  console.log(
    `\nSources disagree. Discovery is only as trustworthy as the weaker of the two;` +
      ` treat the union as the pool set and the difference as a known gap.`,
  );
} else {
  console.log(`\nSources agree exactly over ${to - from + 1n} blocks.`);
}
