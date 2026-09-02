import { getDb } from '../src/db/index.js';
import { rpcHost } from '../config/chain.js';
import {
  measureV4Volume,
  measureV3Volume,
  recentWindow,
  saveVolume,
} from '../src/volume/swaps.js';
import { buildVolumeReport, feedCoverage } from '../src/volume/usd.js';

/**
 * Measure stock-paired swap volume over a recent window and compare it with
 * the figure Bankr publishes for its own tokens.
 *
 * The comparison is a sanity check on the indexer, not a restatement of
 * Bankr's number: theirs covers Bankr-launched tokens across every venue and
 * pair, ours covers stock-paired pools from every launchpad. They should be
 * the same order of magnitude. If ours is far below, discovery is missing
 * pools; far above, something is being double counted.
 *
 *   npm run volume:sync              # last 24h
 *   npm run volume:sync -- --hours=6
 */
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

const hours = Number(arg('hours') ?? 24);
/** Bankr's own dashboard figure for daily volume on its tokens, for comparison. */
const BANKR_DAILY_USD = 1_570_000;

console.log(`volume | last ${hours}h | rpc ${rpcHost()}`);

const win = await recentWindow(hours * 3600);
const spanHours = (win.toTs - win.fromTs) / 3600;
console.log(
  `window blocks ${win.fromBlock}-${win.toBlock} (${win.toBlock - win.fromBlock} blocks, ` +
    `${spanHours.toFixed(2)}h actual)\n`,
);

const started = Date.now();
let lastLog = 0;
const tick = (label: string) => (done: number, pools: number) => {
  const now = Date.now();
  if (now - lastLog < 1_000) return;
  lastLog = now;
  console.log(`  ${label} ${(done * 100).toFixed(1)}% | ${pools} pools with swaps`);
};

const v4 = await measureV4Volume(win, tick('v4'));
saveVolume('v4', win, v4);
console.log(`  v4: ${v4.size} pools traded`);

const v3Pools = (
  getDb().prepare('SELECT address FROM pools_v3').all() as unknown as Array<{ address: string }>
).map((r) => r.address);
const v3 = await measureV3Volume(win, v3Pools, tick('v3'));
saveVolume('v3', win, v3);
console.log(`  v3: ${v3.size} of ${v3Pools.length} known pools traded`);
console.log(`  measured in ${((Date.now() - started) / 60_000).toFixed(1)}m\n`);

const rep = await buildVolumeReport();
const cov = feedCoverage();
const perDay = rep.hours > 0 ? (rep.totalUsd / rep.hours) * 24 : 0;

const usd = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(0)}`;

console.log('stock-paired volume');
console.log(`  window            ${rep.hours.toFixed(2)}h, blocks ${rep.fromBlock}-${rep.toBlock}`);
console.log(`  pools with swaps  ${rep.pools.length} (${rep.totalSwaps} swaps)`);
console.log(`  priced            ${rep.pricedPools} pools -> ${usd(rep.totalUsd)}`);
console.log(
  `  unpriceable       ${rep.unpricedPools} pools / ${rep.unpricedSwaps} swaps ` +
    `(stock has no Chainlink feed; ${cov.withFeed}/${cov.total} tokens covered)`,
);
console.log(`  extrapolated 24h  ${usd(perDay)}`);
console.log(
  `  vs Bankr $1.57M   ${perDay > 0 ? `${((perDay / BANKR_DAILY_USD) * 100).toFixed(0)}%` : 'n/a'} ` +
    `(different denominators -- see script header)`,
);

console.log('\ntop pools by measured USD volume');
for (const p of rep.pools.slice(0, 15)) {
  const label = p.hookLabel ? ` [${p.hookLabel}]` : '';
  console.log(
    `  ${p.protocol} ${p.stockSymbol.padEnd(6)} ${p.poolKey.slice(0, 12)}… ` +
      `${String(p.swaps).padStart(6)} swaps  ` +
      `${p.volumeUsd !== null ? usd(p.volumeUsd).padStart(9) : '  unpriced'}${label}`,
  );
}

const byProtocol = { v4: 0, v3: 0 };
const swapsByProtocol = { v4: 0, v3: 0 };
for (const p of rep.pools) {
  byProtocol[p.protocol] += p.volumeUsd ?? 0;
  swapsByProtocol[p.protocol] += p.swaps;
}
console.log('\nby protocol');
console.log(`  v4 ${usd(byProtocol.v4).padStart(9)}  ${swapsByProtocol.v4} swaps`);
console.log(`  v3 ${usd(byProtocol.v3).padStart(9)}  ${swapsByProtocol.v3} swaps`);
