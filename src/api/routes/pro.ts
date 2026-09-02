import type { FastifyInstance } from 'fastify';
import { formatUsdc, paymentConfig, priceUnits, tokenGate, PAYMENT_CHAIN_ID } from '../../../config/payments.js';
import { claimPayment } from '../../payments/verify.js';
import { tierForSession } from '../../auth/session.js';
import { tokenFrom } from './auth.js';

/**
 * Buying pro, and seeing what it costs.
 *
 * There is no checkout session, no provider redirect and no webhook: the user
 * sends USDC to the treasury with their own wallet and hands us the hash. The
 * server then reads the chain. That means nothing to spoof, nothing to trust,
 * and no state that can disagree with what actually happened on-chain.
 */
export function registerPro(app: FastifyInstance): void {
  app.get('/pro', async (req) => {
    const me = tierForSession(tokenFrom(req as never));
    return {
      price: { usd: paymentConfig.priceUsd, usdc: formatUsdc(priceUnits()) },
      period: { days: paymentConfig.periodDays, renews: false },
      pay: {
        chain: 'base',
        chainId: PAYMENT_CHAIN_ID,
        token: paymentConfig.usdc,
        symbol: 'USDC',
        to: paymentConfig.treasury,
        amount: priceUnits().toString(),
        confirmations: paymentConfig.confirmations,
      },
      // Said plainly rather than buried: a period that silently renews is the
      // thing people resent, and this one does not.
      note:
        `Send ${formatUsdc(priceUnits())} USDC on Base to the treasury, then POST the ` +
        `transaction hash to /pro/claim. Buys ${paymentConfig.periodDays} days. ` +
        `It does not auto-renew — buy another period when it lapses.`,
      tokenGate: tokenGate.enabled
        ? { enabled: true, token: tokenGate.address, minBalance: tokenGate.minBalance }
        : { enabled: false, note: 'token-gated access is planned; no token exists yet' },
      you: { tier: me.tier, address: me.subject, reason: me.reason },
    };
  });

  app.post('/pro/claim', async (req, reply) => {
    const body = req.body as { txHash?: unknown } | undefined;
    const txHash = typeof body?.txHash === 'string' ? body.txHash : '';
    if (!txHash) return reply.code(400).send({ error: 'body must be {"txHash": "0x…"}' });

    const res = await claimPayment(txHash);
    if (!res.ok) {
      req.log.info(`pro claim rejected for ${txHash.slice(0, 12)}…: ${res.error}`);
      return reply.code(400).send({ ok: false, error: res.error });
    }

    req.log.info(`pro granted to ${res.payer} until ${new Date(res.expiresAt).toISOString()}`);
    return {
      ok: true,
      tier: 'pro',
      address: res.payer,
      paid: `${res.paid} USDC`,
      expiresAt: new Date(res.expiresAt).toISOString(),
      alreadyClaimed: res.alreadyClaimed,
      // The address that paid is the one entitled. Signing in with a
      // different wallet will not find this entitlement, and saying so here
      // saves a confused support message later.
      note: 'Sign in with this address to use pro on the dashboard.',
    };
  });
}
