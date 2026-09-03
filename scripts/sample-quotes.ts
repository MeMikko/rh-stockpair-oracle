import { rpcHost } from '../config/chain.js';
import {
  poolsToSample, pruneHistory, saveSnapshots, takeSnapshot, type Snapshot,
} from '../src/history/snapshot.js';
import { historyDepth } from '../src/history/series.js';

/**
 * Record what the busiest stock-paired pools are priced at, right now.
 *
 * Run on a timer. Every run that does not happen is a gap nobody can fill
 * later: the public RPC has no archive, so this series exists only because
 * something wrote it down at the time.
 *
 *   npm run sample                       # top 20 pools, prune past 180 days
 *   npm run sample -- --pools=40
 *   npm run sample -- --keep-days=365
 *   npm run sample -- --dry              # read and print, write nothing
 */
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const limit = Number(arg('pools') ?? 20);
const keepDays = Number(arg('keep-days') ?? 180);
const dry = flag('dry');

if (!Number.isFinite(limit) || limit <= 0) {
  console.error('--pools must be a positive number');
  process.exit(1);
}

const pools = poolsToSample(limit);
console.log(`sample | ${pools.length} pools | rpc ${rpcHost()}${dry ? ' | dry run' : ''}`);
if (pools.length === 0) {
  console.log('no stock-paired pools indexed yet — nothing to sample');
  process.exit(0);
}

const at = Date.now();
const rows: Snapshot[] = [];
const failures: Array<{ pool: string; error: string }> = [];

// Sequential rather than parallel. This runs against a shared public RPC on a
// timer that will fire forever; twenty reads spread over a few seconds is
// politer than twenty at once, and nothing here is waiting on the result.
for (const p of pools) {
  try {
    // One timestamp for the whole run, so a session boundary crossed midway
    // cannot split one sweep across two sessions.
    const snap = await takeSnapshot(p, at);
    rows.push(snap);
    const dev = snap.deviation === null ? `null (${snap.deviationReason})` : `${(snap.deviation * 100).toFixed(2)}%`;
    console.log(
      `  ${snap.protocol} ${snap.poolKey.slice(0, 12)}… ${snap.stockSymbol ?? '?'} ` +
        `spot=${snap.spot.toPrecision(6)} dev=${dev} ${snap.marketSession}`,
    );
  } catch (err) {
    // One unreadable pool must not cost the whole sweep. A missing row is a
    // gap; a thrown run is every pool's gap.
    failures.push({ pool: p.key, error: (err as Error).message.slice(0, 120) });
  }
}

if (!dry) {
  saveSnapshots(rows);
  const pruned = pruneHistory(keepDays);
  if (pruned.snapshots || pruned.volume) {
    console.log(`pruned ${pruned.snapshots} snapshots, ${pruned.volume} volume windows past ${keepDays}d`);
  }
}

for (const f of failures) console.error(`  ! ${f.pool.slice(0, 12)}…: ${f.error}`);

const depth = historyDepth();
console.log(
  `\n${dry ? 'would write' : 'wrote'} ${rows.length} snapshots` +
    (failures.length ? `, ${failures.length} failed` : '') +
    ` | history now ${depth.snapshots} snapshots across ${depth.symbols} symbols` +
    (depth.since ? `, since ${new Date(depth.since).toISOString()}` : ''),
);

// A sweep where nothing at all could be read is a failure worth a non-zero
// exit, so a timer's failure counter notices. Some pools failing is not.
if (rows.length === 0) process.exit(1);
