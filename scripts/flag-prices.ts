import { getDb } from '../src/db/index.js';
import { flagForAdjacent, JUMP_PERCENT, MAX_GAP_MINUTES } from '../src/history/priceFlag.js';

/**
 * Re-derive every price flag from the stored series.
 *
 * The rule is inherited from a measurement made on a different price source
 * (see src/history/priceFlag.ts), so it will be replaced once this deployment
 * has enough history to measure its own distribution. That replacement is only
 * useful if the past can be re-judged under it — which is what this script is
 * for, and what HoodGrow could not do at all: it had kept only the derived
 * price, so 60 days of it could never be re-examined.
 *
 * Safe to re-run. Every flag is recomputed from scratch, so a changed
 * threshold takes effect on the next pass and rows that no longer trip the
 * rule are CLEARED rather than left behind. No price is ever altered.
 *
 *   npm run flag:prices              # report what it would change, write nothing
 *   npm run flag:prices -- --apply
 */
const apply = process.argv.includes('--apply');
const db = getDb();

const rows = db
  .prepare(
    `SELECT pool_key, at, spot, price_flag FROM quote_snapshots
     ORDER BY pool_key ASC, at ASC`,
  )
  .all() as Array<{ pool_key: string; at: number; spot: string; price_flag: string | null }>;

console.log(`read ${rows.length} snapshots | rule: >=${JUMP_PERCENT}% within ${MAX_GAP_MINUTES}min`);

// Grouped in memory rather than with a window function, so the rule lives in
// exactly one place and is the same code the tests cover. A SQL
// reimplementation would be a second definition free to drift from the first.
let previousPool: string | null = null;
let previous: { at: number; spot: number } | null = null;
const changes: Array<{ pool: string; at: number; from: string | null; to: string | null }> = [];

for (const r of rows) {
  if (r.pool_key !== previousPool) {
    previousPool = r.pool_key;
    previous = null;
  }
  const current = { at: Number(r.at), spot: Number(r.spot) };
  const flag = flagForAdjacent(previous, current);
  if (flag !== r.price_flag) {
    changes.push({ pool: r.pool_key, at: current.at, from: r.price_flag, to: flag });
  }
  previous = current;
}

const set = db.prepare('UPDATE quote_snapshots SET price_flag = ? WHERE pool_key = ? AND at = ?');
if (apply && changes.length > 0) {
  db.exec('BEGIN');
  try {
    for (const c of changes) set.run(c.to, c.pool, c.at);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const added = changes.filter((c) => c.to !== null).length;
const cleared = changes.filter((c) => c.to === null).length;
for (const c of changes.slice(0, 20)) {
  console.log(
    `  ${c.pool.slice(0, 12)}… ${new Date(c.at).toISOString()} ${c.from ?? '-'} -> ${c.to ?? '-'}`,
  );
}
if (changes.length > 20) console.log(`  … and ${changes.length - 20} more`);

const flagged = (
  db.prepare('SELECT COUNT(*) AS n FROM quote_snapshots WHERE price_flag IS NOT NULL').get() as {
    n: number;
  }
).n;
console.log(
  `\n${apply ? 'applied' : 'would apply'} ${changes.length} changes (${added} flagged, ` +
    `${cleared} cleared) | ${flagged} of ${rows.length} rows currently flagged` +
    (apply ? '' : '  — re-run with --apply to write'),
);
