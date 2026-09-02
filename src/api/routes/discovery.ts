import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROUTE_PRICES, pricingMode } from '../../../config/pricing.js';
import { paymentConfig, priceUnits, PAYMENT_CHAIN_ID, formatUsdc } from '../../../config/payments.js';
import { agentIdentity } from '../../../config/agent.js';
import { authConfigured } from '../../auth/session.js';

/**
 * A machine-readable description of this service.
 *
 * Written because an external agent tested every endpoint twice and reported
 * "authentication and billing specs missing" both times -- while wallet
 * sign-in and x402 were live the whole while. It never saw them, because it
 * never fetched the HTML landing page. Nothing that only exists in prose on a
 * web page exists for the callers this service is built for.
 *
 * Served three ways so it is hard to miss: at /.well-known/agent.json, from
 * GET / when the client asks for JSON, and advertised in a Link header on
 * every response.
 */

export function serviceDescriptor(): Record<string, unknown> {
  const priced = Object.entries(ROUTE_PRICES)
    .filter(([, p]) => p > 0)
    .map(([route]) => route)
    .sort();

  return {
    name: agentIdentity.service,
    agent: {
      name: agentIdentity.name,
      farcaster: `@${agentIdentity.farcasterHandle}`,
      profile: agentIdentity.farcasterUrl,
      // Tagging it is a supported interface, not just a social presence.
      usage: `Tag @${agentIdentity.farcasterHandle} on Farcaster with a question. ` +
        `Subscribers are answered directly; everyone else is answered after review.`,
    },
    chainId: 4663,
    source: 'https://github.com/MeMikko/rh-stockpair-oracle',

    endpoints: {
      'GET /health': 'index freshness: pool counts, cursors with lag in seconds',
      'GET /coverage': 'which of the 194 stock tokens have a Chainlink feed',
      'GET /price?symbol=': "a stock's own USD price from Chainlink; 404 with a reason where no feed exists",
      'GET /pools?symbol=': 'pool counts for a stock, split by protocol',
      'GET /volume': '24h stock-paired volume and the window it was measured over',
      'GET /corporate-actions?withinDays=': 'upcoming splits and dividends joined to affected pools',
      'GET /quote?pool=&size=': 'implied USD, depth, price impact, Chainlink deviation, market hours',
      'POST /prepare-swap': 'unsigned UniversalRouter calldata with a min-out from the quoter',
      'POST /ask': 'free-text question; returns facts and a reproduce call',
    },

    /**
     * Read this before trusting a number. These three are the ones consumers
     * get wrong, and each has cost a reviewer time already.
     */
    contract: {
      reproduce:
        'Every /ask answer carries a `reproduce` field naming a different route that ' +
        'returns the same figure independently. Call it to verify rather than trust.',
      deviationNull:
        'deviation: null is normal and never means zero. 159 of 194 stock tokens have no ' +
        'Chainlink feed, so a deviation is unknowable rather than absent. Read deviationReason.',
      depthVsImpact:
        'depth is an active-tick estimate and can mislead. impact comes from an on-chain ' +
        'quoter simulation. Size a trade on impact.',
      volumeFreshness:
        'Volume is a rolling 24h measurement refreshed every 6h, not live. GET /volume ' +
        'reports measuredSecondsAgo; use it rather than deriving age from a block delta.',
      neverSigns: 'Nothing here signs, broadcasts, or holds funds. /prepare-swap returns calldata only.',
    },

    auth: {
      required: pricingMode === 'paid',
      note:
        pricingMode === 'launch'
          ? 'Launch mode: every route is served without charge and no credential is needed. ' +
            'The methods below already work and will be required when billing is enabled.'
          : 'Billing is enabled. Use one of the methods below.',
      methods: [
        {
          id: 'x402',
          for: 'agents, per call, no account',
          how:
            'Call a priced route with no credential to receive HTTP 402. The body carries the ' +
            'chain, asset, amount and address. Send USDC on Base to the treasury, then retry ' +
            'with header `x-payment: <transaction hash>`. The full amount becomes prepaid ' +
            'credit and each call debits its own price; a transfer costs more than one call is ' +
            'worth, so one transfer funds many.',
          balance: 'GET /x402/balance?payer=0x…',
          header: 'x-payment',
        },
        {
          id: 'wallet-signature',
          for: 'humans and agents holding a key, session-based',
          how:
            'GET /auth/nonce?address=0x… returns a nonce and the exact message to sign. ' +
            'personal_sign it, then POST /auth/verify {address, signature, nonce}. Returns a ' +
            'bearer token, also set as an HttpOnly cookie. Send it as `Authorization: Bearer <token>`.',
          available: authConfigured(),
        },
        {
          id: 'pro-subscription',
          for: 'unmetered access plus direct answers on Farcaster',
          how:
            `Send ${formatUsdc(priceUnits())} USDC on Base to the treasury, then POST ` +
            '/pro/claim {txHash}. Buys 30 days and does not auto-renew. POST /pro/link-fid ' +
            '{fid} links a Farcaster account so tagging the agent is answered directly.',
          price: { usd: paymentConfig.priceUsd, days: paymentConfig.periodDays, autoRenews: false },
        },
      ],
    },

    payment: {
      chain: 'base',
      chainId: PAYMENT_CHAIN_ID,
      asset: paymentConfig.usdc,
      assetSymbol: 'USDC',
      assetDecimals: paymentConfig.usdcDecimals,
      payTo: paymentConfig.treasury,
      confirmations: paymentConfig.confirmations,
    },

    pricing: {
      mode: pricingMode,
      currency: 'USD',
      perCall: ROUTE_PRICES,
      pricedRoutes: priced,
      headers: {
        'x-oracle-price-usd': 'what this route will cost when billing is on',
        'x-oracle-charged-usd': 'what it cost on this call',
        'x-oracle-pricing': 'launch | paid',
      },
    },

    limits: {
      multiHopSwaps:
        "not supported. RH's UniversalRouter ExactInputParams carries a field upstream " +
        'v4-periphery does not have; it was empty in every live sample decoded, so its type ' +
        'cannot be determined and guessing it would emit calldata that reverts.',
      pushAlerts: 'not yet. Corporate actions and gas changes are polled, not pushed.',
    },
  };
}

export function registerDiscovery(app: FastifyInstance): void {
  const send = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('cache-control', 'public, max-age=300');
    return serviceDescriptor();
  };

  app.get('/.well-known/agent.json', send);
  // Same document under a second name: agents look in both places, and a
  // description nobody finds is the problem this is solving.
  app.get('/api', send);

  app.addHook('onSend', async (_req, reply, payload) => {
    // Advertised on every response, so a caller that only ever touches one
    // endpoint still learns where the description is.
    reply.header('link', '</.well-known/agent.json>; rel="service-desc"; type="application/json"');
    return payload;
  });
}
