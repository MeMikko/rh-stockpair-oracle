import { backfill, backfillV3 } from '../src/indexer/backfill.js';
import { parseSource } from '../src/indexer/sources.js';
import { logsRpcHost } from '../config/chain.js';
import { discoverStartBlock } from '../src/indexer/startBlock.js';

/**
 * Genesis backfill of pool discovery.
 *
 * Defaults have changed deliberately: this walks from the deploying contract's
 * creation block rather than from "tip minus one chunk". A recent-window index
 * makes /quote answer for the pools it happens to hold while implying it holds
 * all of them, which is the kind of quietly wrong claim the project rules
 * exist to prevent.
 *
 *   npm run index:backfill                    # v4, from PoolManager creation
 *   npm run index:backfill -- --v3            # v3 factory instead
 *   npm run index:backfill -- --source=blockscout
 *   npm run index:backfill -- --from=52000000 --fresh
 */
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const which = flag('v3') ? 'v3' : 'v4';
const source = parseSource(arg('source'));
const fromArg = arg('from');
const maxRanges = arg('max-ranges') ? Number(arg('max-ranges')) : undefined;

const from = fromArg ? BigInt(fromArg) : await discoverStartBlock(which);

console.log(
  `${which} backfill | source=${source}` +
    (source === 'rpc' ? ` (${logsRpcHost()})` : '') +
    ` | from block ${from}${fromArg ? '' : ' (contract creation)'}`,
);

const started = Date.now();
let lastLog = 0;

const run = which === 'v3' ? backfillV3 : backfill;
const res = await run({
  fromBlock: from,
  maxRanges,
  resume: !flag('fresh'),
  source,
  onProgress: ({ to, span, done, ranges, stockPaired }) => {
    // One line per second, not one per range: a 52M-block walk makes tens of
    // thousands of ranges and a per-range log buries the failures.
    const now = Date.now();
    if (now - lastLog < 1_000) return;
    lastLog = now;
    const mins = (now - started) / 60_000;
    console.log(
      `  ${(done * 100).toFixed(2)}% | block ${to} | span ${span} | ` +
        `${ranges} ranges | ${stockPaired} stock-paired | ${mins.toFixed(1)}m`,
    );
  },
});

console.log(
  `\n${which} | ${res.ranges} ranges | ${res.pools} pools | ${res.stockPaired} stock-paired | ` +
    `${res.failures} failures | blocks ${res.fromBlock}-${res.toBlock} | ` +
    `${res.complete ? 'COMPLETE' : 'INCOMPLETE (rerun to resume)'}`,
);
if (!res.complete) process.exitCode = 1;
