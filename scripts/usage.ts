import { tolerateClosedPipe } from '../src/util/stdout.js';
import { getDb } from '../src/db/index.js';
import { priceFor, pricingMode } from '../config/pricing.js';
import { fetchLlmSpend, llmConfigured } from '../src/llm/spend.js';

tolerateClosedPipe();

/**
 * What the service is actually being asked for, and what that would be worth.
 *
 * The "would have earned" column is the point: it is the evidence for whether
 * a price is right before anyone is charged it. During launch every call is
 * served for nothing, so this is a forecast, not revenue.
 */
const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 30);
const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const db = getDb();

const rows = db
  .prepare(
    `SELECT route, SUM(calls) AS calls, COUNT(DISTINCT caller) AS callers
       FROM usage WHERE day >= ? GROUP BY route ORDER BY calls DESC`,
  )
  .all(since) as unknown as Array<{ route: string; calls: number; callers: number }>;

console.log(`usage since ${since} | pricing mode: ${pricingMode}\n`);
// No longer an early exit: the LLM section below is worth printing even when
// nobody has called the service, because the agent replying on Farcaster
// spends credits whether or not the API sees traffic.
const noCalls = rows.length === 0;
if (noCalls) console.log('no calls recorded yet');

let totalCalls = 0;
let totalValue = 0;
if (!noCalls) console.log('  route              calls   callers   price   would have earned');
for (const r of rows) {
  const price = priceFor(r.route) ?? 0;
  const value = price * r.calls;
  totalCalls += r.calls;
  totalValue += value;
  console.log(
    `  ${r.route.padEnd(18)} ${String(r.calls).padStart(6)}   ${String(r.callers).padStart(7)}` +
      `   $${price.toFixed(3)}   $${value.toFixed(2)}`,
  );
}
if (!noCalls) {
  console.log(`\n  ${'total'.padEnd(18)} ${String(totalCalls).padStart(6)}` +
              `${' '.repeat(21)}$${totalValue.toFixed(2)}`);
}

if (!noCalls) {
  const distinct = (
    db.prepare('SELECT COUNT(DISTINCT caller) AS n FROM usage WHERE day >= ?').get(since) as unknown as { n: number }
  ).n;
  console.log(`  ${distinct} distinct caller(s) over ${days} days`);
  if (pricingMode === 'launch') {
    console.log('\nLaunch mode: nothing was charged. The figures above are what the');
    console.log('current price list would have produced at this volume.');
  }
}

/**
 * The pricing rule, checked rather than asserted.
 *
 * CLAUDE.md says a price must cover the LLM credits it consumes. That was a
 * claim with one dashboard screenshot behind it, from a different session.
 * The gateway reports both sides, so the report can put them next to each
 * other and let the rule be wrong out loud.
 */
if (!llmConfigured()) {
  console.log('\nLLM spend: BANKR_LLM_API_KEY is not set here, so the model cost is unknown.');
} else {
  try {
    const llm = await fetchLlmSpend(days);
    if (llm) {
      console.log(`\nLLM spend over the same ${llm.days} days`);
      console.log(`  requests   ${llm.requests}`);
      console.log(`  cost       $${llm.costUsd.toFixed(4)}`);
      for (const m of llm.byModel.slice(0, 4)) {
        console.log(
          `    ${m.model.padEnd(22)} ${String(m.requests).padStart(5)} req  $${m.costUsd.toFixed(4)}`,
        );
      }
      if (llm.balanceUsd !== null) console.log(`  balance    $${llm.balanceUsd.toFixed(2)} spendable`);
      if (llm.dailyBudget) {
        const b = llm.dailyBudget;
        console.log(`  budget     $${b.spentUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)} in the last 24h`);
      }

      // Not a margin. The prices are set to cover upstream cost rather than
      // earn one, so covering it is the pass condition and the remainder is
      // slack -- calling it profit would misread the pricing decision.
      const slack = totalValue - llm.costUsd;
      console.log(
        `\n  priced calls would have earned $${totalValue.toFixed(2)}; ` +
          `the model cost $${llm.costUsd.toFixed(4)}`,
      );
      console.log(
        slack >= 0
          ? `  -> covered, with $${slack.toFixed(2)} of slack`
          : `  -> NOT covered: short by $${Math.abs(slack).toFixed(2)}`,
      );
      if (llm.requests === 0 && totalCalls > 0) {
        console.log('  (no model calls in this window; the data path has no LLM in it)');
      }
    }
  } catch (err) {
    // The usage table above already printed. A gateway that cannot be reached
    // costs us that section, not the report.
    console.log(`\nLLM spend: could not read the gateway (${(err as Error).message.slice(0, 100)})`);
  }
}
