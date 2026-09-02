import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/index.js';
import { PAYMENT_CHAIN_ID, paymentConfig } from '../../config/payments.js';
import { priceFor, pricingMode } from '../../config/pricing.js';
import { claimPayment } from '../payments/verify.js';
import { tierForSession } from '../auth/session.js';

/**
 * x402: pay-per-call for agents, over HTTP 402.
 *
 * The point is that a caller needs no account, no key and no prior
 * relationship — it calls, gets a 402 describing what to pay and where, pays,
 * and calls again with proof. That is the right shape for an agent that found
 * this service in a catalogue thirty seconds ago.
 *
 * **Payment is settled as prepaid credit, not per request.** A USDC transfer
 * costs more in gas and latency than a $0.005 call is worth, so one transfer
 * buys a balance that many calls draw down. The 402 still advertises the
 * per-call price, which is what the caller actually cares about; the transfer
 * is just how the balance is topped up.
 *
 * Off while `PRICING_MODE=launch`: everything is served, the 402 never fires,
 * and the price headers say what it will cost. Flipping to `paid` is what
 * turns this on.
 */

const HEADER_PAYMENT = 'x-payment';
const HEADER_RESPONSE = 'x-payment-response';

/** Credit balance in USDC base units for a payer. */
export function creditBalance(payer: string): bigint {
  const row = getDb()
    .prepare('SELECT balance FROM x402_credits WHERE payer = ?')
    .get(payer.toLowerCase()) as { balance: string } | undefined;
  return row ? BigInt(row.balance) : 0n;
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
  const key = payer.toLowerCase();
  db.exec('BEGIN');
  try {
    const next = creditBalance(key) + units;
    db.prepare(
      `INSERT INTO x402_credits (payer, balance, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(payer) DO UPDATE SET
         balance = excluded.balance, updated_at = excluded.updated_at`,
    ).run(key, next.toString(), Date.now());
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

/** Price of a route in USDC base units. */
function priceUnitsFor(route: string): bigint {
  const usd = priceFor(route);
  if (usd === null || usd <= 0) return 0n;
  return BigInt(Math.round(usd * 10 ** paymentConfig.usdcDecimals));
}

/**
 * What a caller must do to pay. Returned as the 402 body so an agent can act
 * on it without reading documentation first.
 */
export function paymentRequirements(route: string) {
  const units = priceUnitsFor(route);
  return {
    x402Version: 1,
    // NOT the x402 `exact` scheme, and deliberately not named as one.
    //
    // In the published protocol, `exact` means a signed EIP-3009
    // authorization presented in a PAYMENT-SIGNATURE header, which a
    // facilitator then submits. Ours is an ordinary on-chain transfer whose
    // hash is presented afterwards. Same intent, different wire protocol.
    //
    // Advertising it as `exact` made a standard client (x402-fetch,
    // `bankr x402 call`, an app's bankr.x402.fetch) sign an authorization we
    // never read, get another 402, and loop. Naming the scheme honestly makes
    // that a clean unsupported-scheme failure on the first try instead.
    accepts: [
      {
        scheme: 'onchain-transfer-credit',
        network: 'base',
        chainId: PAYMENT_CHAIN_ID,
        asset: paymentConfig.usdc,
        assetSymbol: 'USDC',
        assetDecimals: paymentConfig.usdcDecimals,
        payTo: paymentConfig.treasury,
        maxAmountRequired: units.toString(),
        resource: route,
        description: `One call to ${route}`,
        mimeType: 'application/json',
      },
    ],
    // Said explicitly because it is the part that differs from a naive
    // reading of x402: a transfer costs more than one call is worth, so a
    // transfer buys credit that many calls draw down.
    settlement: {
      mode: 'prepaid-credit',
      // Stated so a caller knows before trying, rather than after failing.
      standardX402: false,
      standardX402Note:
        'A signed EIP-3009 authorization (PAYMENT-SIGNATURE) is not accepted yet. Pay ' +
        'on-chain and present the transaction hash as described below.',
      howToPay:
        `Send USDC on Base to ${paymentConfig.treasury}, then retry with header ` +
        `${HEADER_PAYMENT}: <transaction hash>. The full amount becomes credit and ` +
        `each call debits its own price. Any amount works; larger transfers mean fewer.`,
      creditEndpoint: 'GET /x402/balance?payer=0x…',
    },
  };
}

/** Routes that x402 gates. `/health` and `/coverage` stay free by design. */
function isGated(route: string | undefined): route is string {
  if (!route) return false;
  const p = priceFor(route);
  return p !== null && p > 0;
}

/**
 * Resolve who is paying for a request.
 *
 * A signed-in pro subscriber is not charged per call: they already paid for
 * the period, and billing them twice for the same access would be theft by
 * carelessness.
 */
async function resolvePayer(
  req: FastifyRequest,
): Promise<{ kind: 'pro' } | { kind: 'credit'; payer: string } | { kind: 'none' }> {
  const cookie = req.headers.cookie;
  const auth = req.headers.authorization;
  const token =
    typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice(7).trim()
      : typeof cookie === 'string'
        ? cookie.match(/(?:^|;\s*)oracle_session=([^;]+)/)?.[1]
        : undefined;
  if (tierForSession(token).tier === 'pro') return { kind: 'pro' };

  const header = req.headers[HEADER_PAYMENT];
  const proof = Array.isArray(header) ? header[0] : header;
  if (!proof) return { kind: 'none' };

  // A transaction hash tops the balance up; it is idempotent, so a caller
  // that sends the same hash on every request simply keeps using the credit
  // that hash already bought.
  if (/^0x[0-9a-fA-F]{64}$/.test(proof.trim())) {
    const res = await claimPayment(proof.trim());
    if (!res.ok) return { kind: 'none' };
    if (!res.alreadyClaimed) {
      const units = BigInt(
        Math.round(Number(res.paid) * 10 ** paymentConfig.usdcDecimals),
      );
      addCredit(res.payer, units);
    }
    return { kind: 'credit', payer: res.payer };
  }

  // Otherwise treat it as a bare payer address drawing on existing credit.
  if (/^0x[0-9a-fA-F]{40}$/.test(proof.trim())) {
    return { kind: 'credit', payer: proof.trim().toLowerCase() };
  }
  return { kind: 'none' };
}

export function registerX402(app: FastifyInstance): void {
  app.get('/x402/balance', async (req, reply) => {
    const payer = (req.query as { payer?: string } | undefined)?.payer?.trim();
    if (!payer || !/^0x[0-9a-fA-F]{40}$/.test(payer)) {
      return reply.code(400).send({ error: 'pass ?payer=0x…' });
    }
    const bal = creditBalance(payer);
    return {
      payer: payer.toLowerCase(),
      balanceUnits: bal.toString(),
      balanceUsdc: (Number(bal) / 10 ** paymentConfig.usdcDecimals).toFixed(6),
      pricingMode,
    };
  });

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (pricingMode !== 'paid') return;
    const route = req.routeOptions?.url;
    if (!isGated(route)) return;

    const payer = await resolvePayer(req);
    if (payer.kind === 'pro') return;

    const cost = priceUnitsFor(route);
    if (payer.kind === 'credit' && spendCredit(payer.payer, cost)) {
      reply.header(
        HEADER_RESPONSE,
        JSON.stringify({
          charged: cost.toString(),
          remaining: creditBalance(payer.payer).toString(),
        }),
      );
      return;
    }

    // 402 carries everything needed to pay and retry, so an agent never has
    // to find the documentation to get unstuck.
    return reply.code(402).send({
      error: 'payment required',
      ...paymentRequirements(route),
      ...(payer.kind === 'credit'
        ? {
            payer: payer.payer,
            balanceUnits: creditBalance(payer.payer).toString(),
            shortfallUnits: (cost - creditBalance(payer.payer)).toString(),
          }
        : {}),
    });
  });
}

/** Stable id for a request, used only in logs. */
export const requestFingerprint = (req: FastifyRequest): string =>
  createHash('sha256').update(`${req.ip}:${req.routeOptions?.url ?? ''}`).digest('hex').slice(0, 8);
