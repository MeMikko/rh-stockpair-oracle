import { backfill } from '../src/indexer/backfill.js';

const fromArg = process.argv.find((a) => a.startsWith('--from='));
const chunksArg = process.argv.find((a) => a.startsWith('--max-chunks='));

const res = await backfill({
  fromBlock: fromArg ? BigInt(fromArg.split('=')[1]!) : undefined,
  maxChunks: chunksArg ? Number(chunksArg.split('=')[1]) : undefined,
  onProgress: ({ from, to, pools, stockPaired }) => {
    if (pools > 0) console.log(`  ${from}-${to}: ${pools} pools, ${stockPaired} stock-paired`);
  },
});

console.log(
  `\n${res.chunks} ranges | ${res.pools} pools | ${res.stockPaired} stock-paired | ${res.failures} rpc failures`,
);
