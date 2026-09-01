import { fetchCorporateActions, saveCorporateActions, upcomingActions } from '../src/corporate/calendar.js';

const actions = await fetchCorporateActions();
saveCorporateActions(actions);
console.log(`corporate actions: ${actions.length} synced`);

const up = upcomingActions(30);
console.log(`\nupcoming within 30 days: ${up.length}`);
for (const a of up) {
  const rate = a.detail.rate ? ` rate=${a.detail.rate}` : '';
  console.log(`  ${a.processDate} (+${a.daysAway}d) ${a.tokenSymbol.padEnd(6)} ${a.type.padEnd(14)} pools=${a.affectedPools}${rate}`);
}
const impactful = up.filter(a => a.affectedPools > 0);
console.log(`\n${impactful.length} of ${up.length} touch an indexed pool`);
