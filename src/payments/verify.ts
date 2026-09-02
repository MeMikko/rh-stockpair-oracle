import {
  createPublicClient, decodeEventLog, http, parseAbiItem, toEventSelector,
  type Address, type Hex, type PublicClient,
} from 'viem';
import { base } from 'viem/chains';
import { getDb } from '../db/index.js';
import { grant } from '../entitlements/index.js';
import { PAYMENT_CHAIN_ID, formatUsdc, paymentConfig, priceUnits } from '../../config/payments.js';

/**
 * Turn a USDC transfer on Base into 30 days of pro.
 *
 * Verified on-chain rather than through a payment processor: the claim is
 * checked against the transfer that actually happened, so there is no webhook
 * to spoof and no provider to trust. Same rule as everything else here — the
 * server reads the chain rather than being told what is true.
 *
 * Four things must hold, and each rejects for a distinct, stated reason:
 * the transaction succeeded and is buried deep enough to be safe from a
 * reorg; it moved at least the price in USDC to the treasury; it is a USDC
 * transfer and not some other token; and it has not already been spent on an
 * entitlement.
 */

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
/** topic0 for Transfer, derived from the ABI item rather than pasted. */
const TRANSFER_TOPIC = toEventSelector(TRANSFER);

let client: PublicClient | undefined;
function baseClient(): PublicClient {
  if (!client) {
    client = createPublicClient({
      chain: base,
      transport: http(paymentConfig.rpcUrl, { timeout: 20_000, retryCount: 3 }),
    }) as PublicClient;
  }
  return client;
}

export type ClaimResult =
  | { ok: true; payer: string; paid: string; expiresAt: number; alreadyClaimed: boolean }
  | { ok: false; error: string };

/** A transaction may only ever buy one period. */
export function claimedAlready(txHash: string): { payer: string; expires_at: number } | null {
  const r = getDb()
    .prepare('SELECT payer, expires_at FROM payments WHERE tx_hash = ?')
    .get(txHash.toLowerCase()) as { payer: string; expires_at: number } | undefined;
  return r ?? null;
}

export async function claimPayment(txHashRaw: string): Promise<ClaimResult> {
  const txHash = txHashRaw.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(txHash)) return { ok: false, error: 'not a transaction hash' };

  // Checked before touching the network: a resubmitted hash is the common
  // case (a user clicking twice), not an error, and it should not cost an RPC
  // round trip or read as a failure.
  const prior = claimedAlready(txHash);
  if (prior) {
    return {
      ok: true,
      payer: prior.payer,
      paid: formatUsdc(priceUnits()),
      expiresAt: Number(prior.expires_at),
      alreadyClaimed: true,
    };
  }

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
  const want = priceUnits();
  if (paid < want) {
    return {
      ok: false,
      error: `paid ${formatUsdc(paid)} USDC, price is ${formatUsdc(want)}`,
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
      `INSERT INTO payments (tx_hash, chain_id, payer, amount, claimed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
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
    if (again) {
      return {
        ok: true, payer: again.payer, paid: formatUsdc(paid),
        expiresAt: Number(again.expires_at), alreadyClaimed: true,
      };
    }
    return { ok: false, error: `could not record the payment: ${(err as Error).message.slice(0, 120)}` };
  }

  return { ok: true, payer, paid: formatUsdc(paid), expiresAt, alreadyClaimed: false };
}
