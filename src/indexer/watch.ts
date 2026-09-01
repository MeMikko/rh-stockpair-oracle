import { getClient, env } from '../../config/chain.js';
import { getCursor, setCursor } from '../db/index.js';
import { fetchInitializeRange, savePools } from './initialize.js';

const STREAM = 'v4:initialize';

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
      const stored = getCursor(STREAM);
      let cursor = stored !== null ? BigInt(stored) + 1n : tip;

      while (cursor <= tip) {
        const to = cursor + chunk - 1n > tip ? tip : cursor + chunk - 1n;
        const rows = await fetchInitializeRange(cursor, to);
        const res = savePools(rows);
        setCursor(STREAM, Number(to));
        if (res.saved > 0) {
          console.log(`[watch] ${cursor}-${to}: ${res.saved} pools (${res.stockPaired} stock-paired)`);
        }
        cursor = to + 1n;
      }
    } catch (err) {
      console.error('[watch]', (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
