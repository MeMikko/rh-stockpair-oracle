import type { FastifyInstance } from 'fastify';
import type { Address, Hex } from 'viem';
import { readGas, estimateComponents } from '../../pricing/gas.js';

/**
 * Gas for chain 4663. Nothing else publishes this today, and it matters
 * because the launch subsidy zeroes the L1 data component -- so today's cost
 * is not what tomorrow's cost will be. The subsidy flag is measured from
 * ArbGasInfo, never assumed from a calendar date.
 */
export function registerGas(app: FastifyInstance): void {
  app.get('/gas', async (req) => {
    const q = req.query as { to?: string; data?: string; from?: string };
    const snapshot = await readGas();

    let estimate = null;
    let estimateError: string | null = null;
    if (q.to && q.data) {
      try {
        estimate = await estimateComponents(
          q.to as Address, q.data as Hex, q.from as Address | undefined,
        );
      } catch (err) {
        estimateError = ((err as Error).message.split('\n')[0] ?? 'estimate failed').slice(0, 220);
      }
    }

    return {
      chainId: 4663,
      ...snapshot,
      estimate,
      estimateError,
      hint: 'pass ?to=&data=(&from=) to split a specific call into L2 and L1-data gas',
      generatedAt: new Date().toISOString(),
    };
  });
}
