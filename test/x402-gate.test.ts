import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The gate itself, with billing actually on.
 *
 * Everything else about x402 can be tested as a pure function; this cannot.
 * The properties that matter are all about ordering and failure: a call is
 * served only after the payment verifies, settled only after the work
 * succeeds, and an authorization buys exactly one response. Each of those is a
 * hook talking to another hook, so the test drives a real Fastify instance.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'x402-gate-')), 'test.db');
process.env.PRICING_MODE = 'paid';
process.env.X402_FACILITATOR_URL = 'https://facilitator.example/x402';
process.env.X402_RESOURCE_BASE = 'https://oracle.sb4s.xyz';
process.env.VATES_BACKEND_SECRET = '0123456789abcdef0123456789abcdef';
process.env.X402_GATEWAY_URL =
  'https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates';
// Pinned so the asset domain never reaches for a Base RPC that is not there.
process.env.X402_ASSET_NAME = 'USD Coin';
process.env.X402_ASSET_VERSION = '2';

const { getDb } = await import('../src/db/index.js');
const { registerX402 } = await import('../src/api/x402.js');
const { refreshSettlement } = await import('../src/payments/settleable.js');

const realFetch = globalThis.fetch;

/** Facilitator answers, in the order the code asks for them. */
let verifyAnswer: unknown = { isValid: true, payer: '0xpayer' };
let settleAnswer: unknown = { success: true, transaction: '0xsettled', network: 'base' };
let facilitatorDown = false;

/**
 * What this stubbed facilitator says it settles.
 *
 * Named in CAIP-2 on purpose: a real facilitator answers either way, and the
 * gate must not hide the `exact` door merely because the chain was spelled
 * `eip155:8453` rather than `base`.
 */
const supportedAnswer = { kinds: [{ scheme: 'exact', network: 'eip155:8453' }] };

globalThis.fetch = (async (url: string) => {
  if (facilitatorDown) throw new Error('connect ECONNREFUSED');
  const path = String(url);
  const body = path.endsWith('/supported')
    ? supportedAnswer
    : path.endsWith('/verify')
      ? verifyAnswer
      : settleAnswer;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as unknown as typeof fetch;

// Warmed once, before any request: the 402 reads this from cache rather than
// waiting on the facilitator, so an unwarmed cache would make the first call
// of the run behave differently from the rest.
await refreshSettlement();

afterAll(() => {
  globalThis.fetch = realFetch;
});

function build() {
  const app = Fastify();
  registerX402(app);
  app.get('/quote', async () => ({ ok: true, served: 'quote' }));
  // A route that fails after payment was verified, to prove nothing is
  // settled for a response the caller never got.
  app.get('/gas', async (_req, reply) => reply.code(500).send({ error: 'upstream' }));
  // Free here, and charged for by the gateway in front of this origin.
  app.get('/health', async () => ({ ok: true }));
  return app;
}

const payment = (nonce: string) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: '0xsig', authorization: { nonce } },
    }),
  ).toString('base64');

let app = build();

beforeEach(async () => {
  getDb().exec('DELETE FROM x402_authorizations');
  getDb().exec('DELETE FROM x402_credits');
  verifyAnswer = { isValid: true, payer: '0xpayer' };
  settleAnswer = { success: true, transaction: '0xsettled', network: 'base' };
  facilitatorDown = false;
  await app.close();
  app = build();
});

afterAll(async () => {
  await app.close();
});

describe('an unpaid call', () => {
  it('is refused with everything needed to pay', async () => {
    const res = await app.inject({ method: 'GET', url: '/quote' });
    expect(res.statusCode).toBe(402);
    const body = res.json();
    expect(body.accepts[0].scheme).toBe('exact');
    expect(body.accepts[0].maxAmountRequired).toBe('20000');
    expect(body.accepts[0].resource).toBe('https://oracle.sb4s.xyz/quote');
  });

  it('does not gate the free routes', async () => {
    // /coverage is priced at 0, so the gate must not touch it. Registered here
    // only to prove the gate lets it through.
    const free = Fastify();
    registerX402(free);
    free.get('/coverage', async () => ({ ok: true }));
    expect((await free.inject({ method: 'GET', url: '/coverage' })).statusCode).toBe(200);
    await free.close();
  });
});

describe('a signed payment', () => {
  it('is served, and settled only afterwards', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payment('0x01') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, served: 'quote' });

    const receipt = JSON.parse(
      Buffer.from(res.headers['x-payment-response'] as string, 'base64').toString('utf8'),
    );
    expect(receipt).toMatchObject({ success: true, transaction: '0xsettled' });

    const row = getDb()
      .prepare('SELECT status, settled_tx FROM x402_authorizations WHERE nonce = ?')
      .get('0x01') as { status: string; settled_tx: string };
    expect(row.status).toBe('settled');
    expect(row.settled_tx).toBe('0xsettled');
  });

  /**
   * x402-fetch sends X-PAYMENT; Bankr's hand-rolled example sends
   * PAYMENT-SIGNATURE. Refusing a payment over the header it arrived in is a
   * 402 the caller cannot debug.
   */
  it('is read under either header name', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'payment-signature': payment('0x0a') },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-payment-response']).toBeDefined();
  });

  /** One authorization, one response. The replay window is the point. */
  it('cannot be replayed for a second call', async () => {
    await app.inject({ method: 'GET', url: '/quote', headers: { 'x-payment': payment('0x02') } });
    const again = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payment('0x02') },
    });
    expect(again.statusCode).toBe(402);
    expect(again.json().error).toMatch(/already used/i);
  });

  it('is refused, with the facilitator’s reason, when verification fails', async () => {
    verifyAnswer = { isValid: false, invalidReason: 'insufficient_funds' };
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payment('0x03') },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().detail).toBe('insufficient_funds');
    // Nothing claimed: a refused payment must not burn the caller's nonce.
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM x402_authorizations').get() as { n: number },
    ).toEqual({ n: 0 });
  });
});

describe('when settlement does not happen', () => {
  it('replaces the response with a 402 rather than serving unpaid work', async () => {
    settleAnswer = { success: false, errorReason: 'authorization_expired' };
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payment('0x04') },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().detail).toBe('authorization_expired');
    // The body is the 402, not the answer that was built before it.
    expect(res.json().served).toBeUndefined();
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));
  });

  it('frees the authorization so the caller can retry with the same signature', async () => {
    settleAnswer = { success: false, errorReason: 'transient' };
    await app.inject({ method: 'GET', url: '/quote', headers: { 'x-payment': payment('0x05') } });
    settleAnswer = { success: true, transaction: '0xok' };
    const retry = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payment('0x05') },
    });
    expect(retry.statusCode).toBe(200);
  });

  it('does not charge for a response the caller never got', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/gas',
      headers: { 'x-payment': payment('0x06') },
    });
    expect(res.statusCode).toBe(500);
    expect(res.headers['x-payment-response']).toBeUndefined();
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM x402_authorizations').get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it('answers 503, not 402, when the facilitator itself is unreachable', async () => {
    facilitatorDown = true;
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payment('0x07') },
    });
    // Telling a caller to pay again for a payment that may be perfectly good
    // is the one answer that must not be given here.
    expect(res.statusCode).toBe(503);
    expect(res.json().retryable).toBe(true);
  });
});

describe('a request Bankr already took the money for', () => {
  const SECRET = '0123456789abcdef0123456789abcdef';
  const PAYER_ADDR = '0x4b19ee2a3de2521a3adc901989944c209c0a60ea';

  it('is served on the gateway secret, and says who it was served for', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-bankr-secret': SECRET, 'x-402-payer': PAYER_ADDR },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oracle-settled-by']).toBe('bankr-gateway');
    expect(res.headers['x-oracle-payer']).toBe(PAYER_ADDR);
  });

  /**
   * The header naming the payer is a plain string. If carrying it were enough,
   * the payment wall would be decoration -- so this is the test that matters
   * most in the file.
   */
  it('is refused when only the payer header is presented', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-402-payer': PAYER_ADDR },
    });
    expect(res.statusCode).toBe(402);
  });

  it('is refused on a wrong secret', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-bankr-secret': 'nope-nope-nope-nope-nope-nope-no' },
    });
    expect(res.statusCode).toBe(402);
  });

  it('tells a caller about the gateway in the 402 itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/quote' });
    expect(res.json().settlement.bankrGateway.url).toContain('x402.bankr.bot');
  });
});

/**
 * The gateway deployed in front of this origin is a path-preserving proxy with
 * its 402 over the whole path space, so it charges $0.02 for the two routes
 * this service gives away. Nothing here can refund that -- Bankr settles before
 * the request arrives. What is in reach is making sure the caller pays for that
 * answer once instead of every time.
 */
describe('a free route reached through the gateway', () => {
  const app = build();
  const SECRET = '0123456789abcdef0123456789abcdef';
  const PAYER_ADDR = '0x4b19ee2a3de2521a3adc901989944c209c0a60ea';

  it('names the URL where the same answer is free', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-bankr-secret': SECRET, 'x-402-payer': PAYER_ADDR },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oracle-free-at-origin']).toBe('https://oracle.sb4s.xyz/health');
  });

  /**
   * The header is for a person's client; the body is what an agent reads. A
   * notice only in a header is a notice to nobody.
   */
  it('says it in the body too, without disturbing what was there', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-bankr-secret': SECRET, 'x-402-payer': PAYER_ADDR },
    });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.freeAtOrigin.url).toBe('https://oracle.sb4s.xyz/health');
    expect(body.freeAtOrigin.note).toMatch(/free/i);
    // Rewritten payloads have bitten this file before: a stale content-length
    // truncates the body at the client rather than here.
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.payload));
  });

  /** Nothing to say to a caller who came here directly: they paid nothing. */
  it('says nothing to a caller who did not come through the gateway', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oracle-free-at-origin']).toBeUndefined();
    expect(res.json().freeAtOrigin).toBeUndefined();
  });

  /** A forged secret is not a gateway request, here as everywhere else. */
  it('says nothing to a forged gateway request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-bankr-secret': 'nope-nope-nope-nope-nope-nope-no' },
    });
    expect(res.headers['x-oracle-free-at-origin']).toBeUndefined();
  });

  /** The priced routes are unaffected: the header is about free ones only. */
  it('does not appear on a priced route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-bankr-secret': SECRET, 'x-402-payer': PAYER_ADDR },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-oracle-free-at-origin']).toBeUndefined();
  });
});

describe('prepaid credit', () => {
  it('draws on a balance when an address is presented', async () => {
    const { addCredit, creditBalance } = await import('../src/payments/credit.js');
    const payer = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    addCredit(payer, 25_000n);

    const res = await app.inject({
      method: 'GET',
      url: '/quote',
      headers: { 'x-payment': payer },
    });
    expect(res.statusCode).toBe(200);
    expect(creditBalance(payer)).toBe(5_000n);
  });

  it('reports the shortfall rather than a bare refusal', async () => {
    const payer = '0x1111111111111111111111111111111111111111';
    const res = await app.inject({ method: 'GET', url: '/quote', headers: { 'x-payment': payer } });
    expect(res.statusCode).toBe(402);
    expect(res.json().shortfallUnits).toBe('20000');
  });
});
