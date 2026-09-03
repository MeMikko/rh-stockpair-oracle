import { getClient, getLogsClient, env } from '../../config/chain.js';
import { getCursor, setCursor } from '../db/index.js';
import { fetchInitializeRange, savePools } from './initialize.js';
import { fetchV3PoolsRange, saveV3Pools } from './v3.js';
import { readGas } from '../pricing/gas.js';

/**
 * Both protocols are followed. v3 carries roughly a third of stock-paired
 * volume on this chain, so a tip follower that watched only v4 would let the
 * v3 half of the index go stale the moment the backfill finished.
 */
const STREAMS = [
  { name: 'v4:initialize', fetch: fetchInitializeRange, save: savePools },
  { name: 'v3:poolcreated', fetch: fetchV3PoolsRange, save: saveV3Pools },
] as const;

/**
 * Tip follower. Polls rather than subscribes: the public endpoint has no
 * reliable filter support, and RH blocks are ~0.25s so a short poll keeps up.
 * Lags the tip by `confirmations` blocks to avoid reorg churn.
 */
/**
 * How often to take a gas sample from inside the follower.
 *
 * The subsidy evidence used to accumulate only when something called /gas, so
 * the window measured *traffic* rather than the chain: nineteen samples over
 * nine hours were an external test and a few curls, and with no callers the
 * thirty-sample threshold would take days to reach. The subsidy this project
 * exists to warn about could end unremarked in the meantime.
 *
 * Five minutes gives thirty samples in two and a half hours, and a window that
 * means the same thing whether or not anyone is looking.
 */
const GAS_SAMPLE_MS = 5 * 60_000;

export async function watch(opts: { intervalMs?: number; confirmations?: number } = {}): Promise<void> {
  const interval = opts.intervalMs ?? 5_000;
  let lastGasSample = 0;
  const confirmations = BigInt(opts.confirmations ?? 5);
  // The tip comes from the same endpoint the logs do, not from the archive
  // node. Two reasons, and the correctness one matters more than the cost:
  // asking one node for the tip and another for logs can request a range the
  // log node has not seen yet. It also happens to save ~17% of a month's
  // Alchemy compute units on a poll that needs no archive at all.
  const client = getLogsClient();
  const chunk = BigInt(env.logChunk);

  for (;;) {
    try {
      const tip = (await client.getBlockNumber()) - confirmations;

      for (const stream of STREAMS) {
        const stored = getCursor(stream.name);
        let cursor = stored !== null ? BigInt(stored) + 1n : tip;

        while (cursor <= tip) {
          const to = cursor + chunk - 1n > tip ? tip : cursor + chunk - 1n;
          const rows = await stream.fetch(cursor, to);
          const res = stream.save(rows as never);
          setCursor(stream.name, Number(to));
          if (res.saved > 0) {
            console.log(
              `[watch] ${stream.name} ${cursor}-${to}: ${res.saved} pools ` +
                `(${res.stockPaired} stock-paired)`,
            );
          }
          cursor = to + 1n;
        }
      }
    } catch (err) {
      console.error('[watch]', (err as Error).message);
    }

    // Sampled here rather than on request, so the evidence reflects the chain
    // rather than who happened to be calling. Failures are ignored: a missed
    // sample is a gap in the window, not a reason to stop following the tip.
    if (Date.now() - lastGasSample >= GAS_SAMPLE_MS) {
      lastGasSample = Date.now();
      try {
        const g = await readGas();
        if (!g.subsidy.l1DataFreeNow) {
          const e = g.subsidy.evidence;
          // Leads with the run, because the counts alone do not say which of
          // the two states this is: once a single blip lands in the window this
          // line prints on every sample for as long as the window retains it,
          // and "26/107 non-zero" reads the same whether the subsidy ended or
          // the reading is flapping.
          const state = e.currentNonZeroRun > 0
            ? `charged: ${g.perL1CalldataUnit} wei, ${e.currentNonZeroRun} consecutive samples ` +
              `over ${Math.round(e.currentNonZeroRunSeconds / 60)}m`
            : `free at this block since ${e.zeroSince === null ? 'unknown' : new Date(e.zeroSince * 1000).toISOString()}`;
          console.log(`[watch] L1 calldata ${state} (${e.nonZeroSamples}/${e.samples} retained samples non-zero)`);
        }
      } catch (err) {
        console.error('[watch] gas sample failed:', (err as Error).message.slice(0, 100));
      }
    }

    await new Promise((r) => setTimeout(r, interval));
  }
}
