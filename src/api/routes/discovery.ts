import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ROUTE_PRICES, pricingMode } from '../../../config/pricing.js';
import { paymentConfig, priceUnits, PAYMENT_CHAIN_ID, formatUsdc } from '../../../config/payments.js';
import { agentIdentity } from '../../../config/agent.js';
import { authConfigured } from '../../auth/session.js';
import {
  facilitatorConfigured, gatewayAdvertised, gatewayTrusted, x402Config,
} from '../../../config/x402.js';

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
      'GET /pools?symbol=':
        'pool counts for a stock split by protocol, plus the top 25 pool identifiers to ' +
        'quote, ordered by measured 24h swaps',
      'GET /volume': '24h stock-paired volume and the window it was measured over',
      'GET /corporate-actions?withinDays=': 'upcoming splits and dividends joined to affected pools',
      'GET /quote?pool=&size=':
        'implied USD, depth, price impact, Chainlink deviation, market hours. Takes a v4 ' +
        'poolId or a v3 pool address; `protocol` in the response says which',
      'POST /prepare-swap':
        'unsigned calldata with a min-out from the quoter: UniversalRouter for a v4 pool, ' +
        'SwapRouter for a v3 pool. Single-hop only; v3 requires an explicit recipient',
      'GET /history?symbol=&hours=':
        'what this service recorded, rather than what it reads now: the price series for a ' +
        "stock's busiest pool and the drift against Chainlink split by market session. " +
        'Cannot be reconstructed from the chain — the public RPC has no archive — so it ' +
        'covers only what has been sampled. GET /health reports the depth, free',
      'POST /ask': 'free-text question; returns facts and a reproduce call',
      'GET /x402/supported': 'which payment schemes and network this deployment settles',
      'POST /x402/topup': 'turn a USDC transfer into prepaid credit: {"txHash": "0x…"}',
      'GET /x402/balance?payer=': 'prepaid credit remaining for an address',
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
        'quoter simulation. Size a trade on impact. `impact.source` names the quoter that ' +
        'produced it: `quoter` for v4, `quoter-v3` for v3.',
      volumeFreshness:
        'Volume is a rolling 24h measurement refreshed every 6h, not live. GET /volume ' +
        'reports measuredSecondsAgo; use it rather than deriving age from a block delta.',
      neverSigns:
        'Nothing on this API signs, broadcasts, or holds your funds. /prepare-swap returns ' +
        'calldata only. The agent has a wallet of its own for paying its own costs; no route ' +
        'here can reach it.',
    },

    auth: {
      required: pricingMode === 'paid',
      note:
        pricingMode === 'launch'
          ? 'Launch mode: every route is served without charge and no credential is needed. ' +
            'The methods below already work and will be required when billing is enabled.'
          : 'Billing is enabled. Use one of the methods below.',
      methods: [
        // First, because it is the door most callers already have an account
        // for -- and the only one where somebody else does the settling.
        ...(gatewayAdvertised()
          ? [
              {
                id: 'bankr-x402-gateway',
                for: 'agents that already pay for things through Bankr',
                available: gatewayTrusted(),
                url: x402Config.gateway.url,
                how:
                  'Call this service at the Bankr URL above instead of here. Bankr issues the ' +
                  '402, takes the USDC on Base, settles it, and forwards the paid request to ' +
                  'this origin with the payer’s address. Same routes, same responses; the ' +
                  'payment is between you and Bankr.',
                note: gatewayTrusted()
                  ? 'Requests forwarded by the gateway are authenticated with a shared secret.'
                  : 'The gateway is published but this origin cannot yet authenticate its ' +
                    'requests, so they are treated as unpaid once billing is on.',
              },
            ]
          : []),
        {
          id: 'x402-exact',
          for: 'agents, per call, no account — the published protocol',
          available: facilitatorConfigured(),
          how:
            'Call a priced route with no credential to receive HTTP 402. `accepts` carries a ' +
            'standard x402 `exact` requirement: sign an EIP-3009 authorization for the amount ' +
            'and resource it names, base64-encode the payment payload, and retry with it in ' +
            'the `X-PAYMENT` header. It is verified and settled through a standard facilitator, ' +
            'which pays the gas — x402-fetch does all of this unchanged. The settlement ' +
            'transaction comes back in `X-PAYMENT-RESPONSE`.',
          facilitator: facilitatorConfigured() ? x402Config.facilitatorUrl : null,
          network: x402Config.network,
          supported: 'GET /x402/supported',
          header: 'x-payment',
          // Said rather than left to be discovered: a deployment with no
          // facilitator still answers 402, and a client that has signed an
          // authorization deserves to know it will not be read.
          note: facilitatorConfigured()
            ? undefined
            : 'No facilitator is configured on this deployment; use x402-credit below.',
        },
        {
          id: 'x402-credit',
          for: 'callers that would rather transfer once than sign per call',
          how:
            'Send USDC on Base to the treasury, then POST the hash to /x402/topup. The full ' +
            'amount becomes prepaid credit — any amount, no minimum — and each call debits its ' +
            'own price. Draw on it with header `x-payment: <your address>`. Sending the ' +
            'transaction hash in that header works too and tops up on first use. This is not ' +
            'the x402 `exact` scheme and is named `onchain-transfer-credit` so a standard ' +
            'client fails cleanly rather than signing something nobody reads.',
          balance: 'GET /x402/balance?payer=0x…',
          topUp: 'POST /x402/topup {"txHash": "0x…"}',
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
      network: x402Config.network,
      asset: paymentConfig.usdc,
      assetSymbol: 'USDC',
      assetDecimals: paymentConfig.usdcDecimals,
      payTo: paymentConfig.treasury,
      // Applies to the transfer-and-credit path only. An `exact` payment is
      // settled by the facilitator, which decides its own confirmation rule.
      confirmations: paymentConfig.confirmations,
      x402: {
        version: 1,
        schemes: facilitatorConfigured() ? ['exact', 'onchain-transfer-credit'] : ['onchain-transfer-credit'],
        facilitator: facilitatorConfigured() ? x402Config.facilitatorUrl : null,
        bankrGateway: gatewayAdvertised()
          ? { url: x402Config.gateway.url, trustedByOrigin: gatewayTrusted() }
          : null,
        supported: 'GET /x402/supported',
      },
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
      v3Calldata:
        'A v3 swap is a different shape, not a different address: it calls the v3 router ' +
        'directly with one plain ERC-20 approval (no Permit2, no second approval), names its ' +
        'recipient in the calldata rather than defaulting to the sender, and takes its ' +
        'deadline from multicall or from the params depending on which router is deployed. ' +
        'The response says which, and whether that was read off the chain or configured.',
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
