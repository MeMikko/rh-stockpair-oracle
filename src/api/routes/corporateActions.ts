import type { FastifyInstance } from 'fastify';
import { upcomingActions } from '../../corporate/calendar.js';
import { getDb } from '../../db/index.js';

/**
 * The corporate-action calendar, joined to the indexed pool set.
 *
 * The calendar is public and the pools are public, but nothing joins them --
 * which is the point. On this chain the adjustment arrives as an ERC-8056
 * multiplier change, so every pool quoted in that stock reprices at once.
 */
export function registerCorporateActions(app: FastifyInstance): void {
  app.get('/corporate-actions', async (req) => {
    const q = req.query as { withinDays?: string; onlyAffecting?: string };
    const withinDays = Math.min(Math.max(Number(q.withinDays ?? 30) || 30, 0), 365);
    const onlyAffecting = q.onlyAffecting === 'true';

    let actions = upcomingActions(withinDays);
    if (onlyAffecting) actions = actions.filter((a) => a.affectedPools > 0);

    const synced = getDb()
      .prepare('SELECT MAX(synced_at) AS t FROM corporate_actions')
      .get() as { t: number | null };

    return {
      chainId: 4663,
      withinDays,
      count: actions.length,
      affectingIndexedPools: actions.filter((a) => a.affectedPools > 0).length,
      actions,
      source: 'https://api.robinhood.com/rhj/corporate-actions',
      note: 'Adjustments apply on-chain via the ERC-8056 uiMultiplier; Chainlink feeds already return multiplier-adjusted prices.',
      syncedAt: synced.t ? new Date(Number(synced.t)).toISOString() : null,
      generatedAt: new Date().toISOString(),
    };
  });
}
