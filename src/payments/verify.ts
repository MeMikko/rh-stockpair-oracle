import {
  decodeEventLog, parseAbiItem, toEventSelector,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { getDb } from '../db/index.js';
import { grant } from '../entitlements/index.js';
import { PAYMENT_CHAIN_ID, formatUsdc, paymentConfig, priceUnits } from '../../config/payments.js';
import { addCreditWithinTx, creditBalance } from './credit.js';
import { baseClient } from './baseClient.js';

/**
 * Turning a USDC transfer on Base into what it bought.
 *
 * Verified on-chain rather than through a payment processor: the claim is
 * checked against the transfer that actually happened, so there is no webhook
 * to spoof and no provider to trust. Same rule as everything else here — the
 * server reads the chain rather than being told what is true.
 *
 * Three things must hold whatever the money is for, and each rejects for a
 * distinct, stated reason: the transaction succeeded and is buried deep enough
 * to be safe from a reorg; it moved USDC — not some other token with the same
 * event signature — to the treasury; and it has not already been spent.
 *
 * What differs is the policy on top. A pro period costs at least its price and
 * grants an entitlement; x402 credit has no minimum and grants a balance. One
 * transaction buys one of the two, never both, and `purpose` on the payments
 * row is what makes that true rather than hoped for.
 */

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
/** topic0 for Transfer, derived from the ABI item rather than pasted. */
const TRANSFER_TOPIC = toEventSelector(TRANSFER);

export type ClaimResult =
  | { ok: true; payer: string; paid: string; expiresAt: number; alreadyClaimed: boolean }
  | { ok: false; error: string };

export type CreditResult =
  | { ok: true; payer: string; creditedUnits: string; balanceUnits: string; alreadyClaimed: boolean }
  | { ok: false; error: string };

/** What a transaction hash has already been spent on, if anything. */
export function claimedAlready(
  txHash: string,
): { payer: string; expires_at: number; purpose: string; amount: string } | null {
  const r = getDb()
    .prepare('SELECT payer, expires_at, purpose, amount FROM payments WHERE tx_hash = ?')
    .get(txHash.toLowerCase()) as
    | { payer: string; expires_at: number; purpose: string; amount: string }
    | undefined;
  return r ?? null;
}

type TransferRead =
  | { ok: true; payer: string; paid: bigint }
  | { ok: false; error: string };

/**
 * What a transaction actually moved to the treasury.
 *
 * Shared by both things a payment can buy, because the reading is the same and
 * the *policy* is what differs: pro wants at least the subscription price and
 * grants an entitlement, credit wants any amount at all and grants a balance.
 * Having one reader means a rule about which logs count cannot hold in one
 * path and not the other.
 */
async function readTreasuryTransfer(txHash: string): Promise<TransferRead> {
  const c = baseClient();

  let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
  try {
    receipt = await c.getTransactionReceipt({ hash: txHash as Hex });
  } catch {
    return { ok: false, error: 'transaction not found on Base; is it confirmed yet?' };
  }
  if (receipt.status !== 'success') return { ok: false, error: 'that transaction reverted' };

  const tip = await c.getBlockNumber();
  const confirmations = tip >= receipt.blockNumber ? tip - receipt.blockNumber + 1n : 0n;
  if (confirmations < BigInt(paymentConfig.confirmations)) {
    return {
      ok: false,
      error: `only ${confirmations} confirmation(s); waiting for ${paymentConfig.confirmations}`,
    };
  }

  // Sum every USDC transfer to the treasury in this transaction. Summing
  // rather than taking the first handles a payment split across transfers,
  // and filtering on the token address is what stops a worthless token with
  // the same event signature from buying anything.
  const treasury = paymentConfig.treasury.toLowerCase();
  const usdc = paymentConfig.usdc.toLowerCase();
  let paid = 0n;
  let payer: string | null = null;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== usdc) continue;
    // Match the event by its topic0, not by hoping the decode fails on
    // anything else. An earlier version compared topic0 to the event *name*,
    // which is never equal -- so every log from the USDC address was handed
    // to the decoder and the filter did nothing.
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    let decoded: { from: Address; to: Address; value: bigint };
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      }).args as unknown as { from: Address; to: Address; value: bigint };
    } catch {
      continue;
    }
    if (decoded.to.toLowerCase() !== treasury) continue;
    paid += decoded.value;
    // The payer is the transfer's sender, not the transaction's. With a smart
    // wallet or a relayer those differ, and crediting the relayer would grant
    // pro to the wrong account.
    payer ??= decoded.from.toLowerCase();
  }

  if (paid === 0n || !payer) {
    return { ok: false, error: 'no USDC transfer to the treasury in that transaction' };
  }
  return { ok: true, payer, paid };
}

export async function claimPayment(txHashRaw: string): Promise<ClaimResult> {
  const txHash = txHashRaw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return { ok: false, error: 'not a transaction hash' };

  // Checked before touching the network: a resubmitted hash is the common
  // case (a user clicking twice), not an error, and it should not cost an RPC
  // round trip or read as a failure.
  const prior = claimedAlready(txHash);
  if (prior) {
    // A hash that already bought credit cannot also buy a period. Saying which
    // it bought is the difference between a caller fixing this in one step and
    // resubmitting the same hash forever.
    if (prior.purpose !== 'pro') {
      return { ok: false, error: `that transaction already bought x402 credit, not a period` };
    }
    return {
      ok: true,
      payer: prior.payer,
      paid: formatUsdc(BigInt(prior.amount)),
      expiresAt: Number(prior.expires_at),
      alreadyClaimed: true,
    };
  }

  const read = await readTreasuryTransfer(txHash);
  if (!read.ok) return { ok: false, error: read.error };
  const { payer, paid } = read;

  const want = priceUnits();
  if (paid < want) {
    return {
      ok: false,
      error:
        `paid ${formatUsdc(paid)} USDC, a period costs ${formatUsdc(want)}. ` +
        'Smaller amounts buy x402 credit instead: POST /x402/topup {"txHash"}.',
    };
  }

  const expiresAt = Date.now() + paymentConfig.periodDays * 86_400_000;
  const db = getDb();
  db.exec('BEGIN');
  try {
    // The payments row is the idempotency record. Inserting it inside the
    // same transaction as the grant means a crash cannot leave a payment
    // spent with no entitlement, or an entitlement with no payment.
    db.prepare(
      `INSERT INTO payments (tx_hash, chain_id, payer, amount, claimed_at, expires_at, purpose)
       VALUES (?, ?, ?, ?, ?, ?, 'pro')`,
    ).run(txHash, PAYMENT_CHAIN_ID, payer, paid.toString(), Date.now(), expiresAt);

    grant('address', payer, {
      tier: 'pro',
      expiresAt,
      source: `payment:${txHash}`,
      note: `${formatUsdc(paid)} USDC on Base`,
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    // A unique-constraint failure here means a concurrent claim of the same
    // hash won the race; that is a success for the caller, not an error.
    const again = claimedAlready(txHash);
    if (again && again.purpose === 'pro') {
      return {
        ok: true, payer: again.payer, paid: formatUsdc(paid),
        expiresAt: Number(again.expires_at), alreadyClaimed: true,
      };
    }
    return { ok: false, error: `could not record the payment: ${(err as Error).message.slice(0, 120)}` };
  }

  return { ok: true, payer, paid: formatUsdc(paid), expiresAt, alreadyClaimed: false };
}

/**
 * Turn a USDC transfer into prepaid x402 credit.
 *
 * Deliberately not `claimPayment`. Routing a top-up through the subscription
 * claim was wrong in both directions at once: a $1 transfer was refused for
 * being under the $5.99 subscription price and bought nothing, while a $6
 * transfer silently granted a 30-day unmetered subscription to a caller who
 * only meant to buy a dollar of calls. The 402 body promised "any amount
 * works", and the code disagreed.
 *
 * Credit therefore has its own claim, no minimum, and no entitlement — and
 * the exact base units are credited rather than a two-decimal rendering of
 * them, so nothing is lost between the transfer and the balance.
 */
export async function claimCredit(txHashRaw: string): Promise<CreditResult> {
  const txHash = txHashRaw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return { ok: false, error: 'not a transaction hash' };

  const prior = claimedAlready(txHash);
  if (prior) {
    if (prior.purpose !== 'credit') {
      return { ok: false, error: 'that transaction already bought a pro period, not credit' };
    }
    return {
      ok: true,
      payer: prior.payer,
      creditedUnits: prior.amount,
      balanceUnits: creditBalance(prior.payer).toString(),
      alreadyClaimed: true,
    };
  }

  const read = await readTreasuryTransfer(txHash);
  if (!read.ok) return { ok: false, error: read.error };
  const { payer, paid } = read;

  const db = getDb();
  let balance: bigint;
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO payments (tx_hash, chain_id, payer, amount, claimed_at, expires_at, purpose)
       VALUES (?, ?, ?, ?, ?, 0, 'credit')`,
    ).run(txHash, PAYMENT_CHAIN_ID, payer, paid.toString(), Date.now());
    balance = addCreditWithinTx(payer, paid);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    const again = claimedAlready(txHash);
    if (again && again.purpose === 'credit') {
      return {
        ok: true,
        payer: again.payer,
        creditedUnits: again.amount,
        balanceUnits: creditBalance(again.payer).toString(),
        alreadyClaimed: true,
      };
    }
    return { ok: false, error: `could not record the top-up: ${(err as Error).message.slice(0, 120)}` };
  }

  return {
    ok: true,
    payer,
    creditedUnits: paid.toString(),
    balanceUnits: balance.toString(),
    alreadyClaimed: false,
  };
}
