/**
 * What the model actually costs us, read from the gateway rather than guessed.
 *
 * The pricing rule in CLAUDE.md is that a price must cover the LLM credits it
 * consumes. That was an assertion with nothing behind it: the only figure
 * anyone had was a $0.16 screenshot from a dashboard. The gateway publishes
 * both the spend and the remaining balance, so the claim can be checked
 * instead of repeated.
 *
 * Never on a request path. This is for the operator's report.
 */

const BASE = process.env.BANKR_LLM_BASE_URL ?? 'https://llm.bankr.bot';
const KEY = process.env.BANKR_LLM_API_KEY ?? '';

export interface LlmSpend {
  days: number;
  requests: number;
  costUsd: number;
  byModel: Array<{ model: string; requests: number; costUsd: number }>;
  /** Spendable credit, net of usage already served but not yet deducted. */
  balanceUsd: number | null;
  /** Present only when a daily cap is configured on the account. */
  dailyBudget: { limitUsd: number; spentUsd: number; remainingUsd: number } | null;
}

export function llmConfigured(): boolean {
  return KEY.length > 0;
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-api-key': KEY, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`gateway ${res.status}: ${(await res.text()).slice(0, 160)}`);
  }
  return res.json();
}

/**
 * Spend over a window plus the current balance. Returns null without a key
 * rather than throwing: a report that cannot reach the gateway should still
 * print the part it does know.
 */
export async function fetchLlmSpend(days = 30): Promise<LlmSpend | null> {
  if (!llmConfigured()) return null;

  const usage = (await get(`/v1/usage?days=${days}`)) as {
    totals?: { totalRequests?: number; totalCost?: number };
    byModel?: Array<{ model?: string; requests?: number; totalCost?: number }>;
  };

  // The balance is a separate call and a separate failure: a usage read that
  // worked still tells us what we spent, so a balance failure must not
  // discard it.
  let balanceUsd: number | null = null;
  let dailyBudget: LlmSpend['dailyBudget'] = null;
  try {
    const credits = (await get('/v1/credits')) as {
      effectiveBalanceUsd?: number;
      balanceUsd?: number;
      dailyBudget?: { limitUsd?: number; spentUsd?: number; remainingUsd?: number };
    };
    // effectiveBalanceUsd nets out in-flight usage; it is the honest figure
    // for "can this keep answering", so prefer it.
    balanceUsd = credits.effectiveBalanceUsd ?? credits.balanceUsd ?? null;
    if (credits.dailyBudget?.limitUsd !== undefined) {
      dailyBudget = {
        limitUsd: credits.dailyBudget.limitUsd,
        spentUsd: credits.dailyBudget.spentUsd ?? 0,
        remainingUsd: credits.dailyBudget.remainingUsd ?? 0,
      };
    }
  } catch {
    balanceUsd = null;
  }

  return {
    days,
    requests: usage.totals?.totalRequests ?? 0,
    costUsd: usage.totals?.totalCost ?? 0,
    byModel: (usage.byModel ?? [])
      .map((m) => ({
        model: m.model ?? 'unknown',
        requests: m.requests ?? 0,
        costUsd: m.totalCost ?? 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    balanceUsd,
    dailyBudget,
  };
}
