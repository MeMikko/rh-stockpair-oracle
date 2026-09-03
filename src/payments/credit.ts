import { getDb } from '../db/index.js';

/**
 * The prepaid-credit ledger.
 *
 * Kept for the callers that already use it, and for the case the `exact`
 * scheme does not cover: a caller that would rather move USDC once than sign
 * an authorization per call. One transfer buys a balance; each call debits its
 * own price.
 *
 * Balances are USDC base units, held as BigInt and stored as strings. Money
 * never touches a float here — not in the arithmetic, not in the column type,
 * and not in the amount credited from a transfer.
 */

/** Credit balance in USDC base units for a payer. */
export function creditBalance(payer: string): bigint {
  const row = getDb()
    .prepare('SELECT balance FROM x402_credits WHERE payer = ?')
    .get(payer.toLowerCase()) as { balance: string } | undefined;
  return row ? BigInt(row.balance) : 0n;
}

/**
 * Add credit without opening a transaction of its own.
 *
 * Exists so a top-up can be written in the same transaction as the payment
 * record that makes it idempotent: crediting outside that transaction means a
 * crash can leave a transfer recorded as spent with no balance behind it, or a
 * balance that a second submission of the same hash tops up again.
 */
export function addCreditWithinTx(payer: string, units: bigint): bigint {
  const key = payer.toLowerCase();
  const next = creditBalance(key) + units;
  getDb()
    .prepare(
      `INSERT INTO x402_credits (payer, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(payer) DO UPDATE SET
         balance = excluded.balance, updated_at = excluded.updated_at`,
    )
    .run(key, next.toString(), Date.now());
  return next;
}

/**
 * Add credit, summed in BigInt rather than in SQL.
 *
 * An earlier version did the arithmetic in SQLite with CAST and bound the
 * addend through Number(), which routes a token amount through a float. Money
 * must not go near a float, and base units are exact integers precisely so
 * they never have to.
 */
export function addCredit(payer: string, units: bigint): bigint {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const next = addCreditWithinTx(payer, units);
    db.exec('COMMIT');
    return next;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Spend from a balance. Returns false when there is not enough, and does not
 * partially debit -- a call is either paid for or it is not.
 */
export function spendCredit(payer: string, units: bigint): boolean {
  const db = getDb();
  const key = payer.toLowerCase();
  db.exec('BEGIN');
  try {
    const have = creditBalance(key);
    if (have < units) {
      db.exec('ROLLBACK');
      return false;
    }
    db.prepare('UPDATE x402_credits SET balance = ?, updated_at = ? WHERE payer = ?').run(
      (have - units).toString(),
      Date.now(),
      key,
    );
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
