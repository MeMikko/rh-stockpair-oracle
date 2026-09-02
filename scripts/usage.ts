import { tolerateClosedPipe } from '../src/util/stdout.js';
import { getDb } from '../src/db/index.js';
import { priceFor, pricingMode } from '../config/pricing.js';

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
if (rows.length === 0) {
  console.log('no calls recorded yet');
  process.exit(0);
}

let totalCalls = 0;
let totalValue = 0;
console.log('  route              calls   callers   price   would have earned');
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
console.log(`\n  ${'total'.padEnd(18)} ${String(totalCalls).padStart(6)}` +
            `${' '.repeat(21)}$${totalValue.toFixed(2)}`);

const distinct = (
  db.prepare('SELECT COUNT(DISTINCT caller) AS n FROM usage WHERE day >= ?').get(since) as unknown as { n: number }
).n;
console.log(`  ${distinct} distinct caller(s) over ${days} days`);
if (pricingMode === 'launch') {
  console.log('\nLaunch mode: nothing was charged. The figures above are what the');
  console.log('current price list would have produced at this volume.');
}
