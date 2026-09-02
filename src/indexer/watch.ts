import { getClient, env } from '../../config/chain.js';
import { getCursor, setCursor } from '../db/index.js';
import { fetchInitializeRange, savePools } from './initialize.js';
import { fetchV3PoolsRange, saveV3Pools } from './v3.js';

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
export async function watch(opts: { intervalMs?: number; confirmations?: number } = {}): Promise<void> {
  const interval = opts.intervalMs ?? 5_000;
  const confirmations = BigInt(opts.confirmations ?? 5);
  const client = getClient();
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
    await new Promise((r) => setTimeout(r, interval));
  }
}
