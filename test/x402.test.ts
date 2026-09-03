import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'x402-')), 'test.db');
// Set before the config module is imported: it snapshots the environment once,
// and a facilitator configured after the fact would not be advertised.
process.env.X402_FACILITATOR_URL = 'https://facilitator.example/x402';
process.env.X402_RESOURCE_BASE = 'https://oracle.sb4s.xyz';
process.env.VATES_BACKEND_SECRET = '0123456789abcdef0123456789abcdef';
process.env.X402_GATEWAY_URL =
  'https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates';

const { getDb } = await import('../src/db/index.js');
const {
  creditBalance, addCredit, spendCredit, payment402Body, requirementsFor,
  readPaymentHeader, LEGACY_SCHEME,
} = await import('../src/api/x402.js');
const { readGatewayRequest } = await import('../src/payments/gateway.js');
const { claimPayment, claimCredit } = await import('../src/payments/verify.js');

const PAYER = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const DOMAIN = { name: 'USD Coin', version: '2', source: 'chain' as const };

beforeEach(() => {
  getDb().exec('DELETE FROM x402_credits');
  getDb().exec('DELETE FROM payments');
});

describe('credit balance', () => {
  it('starts at zero for an unknown payer', () => {
    expect(creditBalance(PAYER)).toBe(0n);
  });

  it('accumulates across top-ups', () => {
    addCredit(PAYER, 5_990_000n);
    addCredit(PAYER, 10_000n);
    expect(creditBalance(PAYER)).toBe(6_000_000n);
  });

  it('is case-insensitive about the payer', () => {
    addCredit(PAYER.toUpperCase().replace('0X', '0x'), 1_000n);
    expect(creditBalance(PAYER)).toBe(1_000n);
  });
});

describe('spending', () => {
  it('debits exactly the price', () => {
    addCredit(PAYER, 10_000n);
    expect(spendCredit(PAYER, 5_000n)).toBe(true);
    expect(creditBalance(PAYER)).toBe(5_000n);
  });

  /** A call is either paid for or it is not; there is no partial service. */
  it('refuses rather than partially debiting', () => {
    addCredit(PAYER, 3_000n);
    expect(spendCredit(PAYER, 5_000n)).toBe(false);
    expect(creditBalance(PAYER)).toBe(3_000n);
  });

  it('refuses a payer with no credit at all', () => {
    expect(spendCredit(PAYER, 1n)).toBe(false);
  });

  it('allows spending the balance down to exactly zero', () => {
    addCredit(PAYER, 5_000n);
    expect(spendCredit(PAYER, 5_000n)).toBe(true);
    expect(creditBalance(PAYER)).toBe(0n);
    expect(spendCredit(PAYER, 1n)).toBe(false);
  });
});

describe('402 body', () => {
  const body = payment402Body('/quote', DOMAIN);

  /**
   * The whole point of the change: a standard client reads accepts[0], and if
   * what it finds is not `exact` it cannot pay at all.
   */
  it('offers the standard scheme first', () => {
    expect(body.accepts[0]!.scheme).toBe('exact');
    expect(body.accepts[0]!.network).toBe('base');
    expect(body.settlement.standardX402).toBe(true);
    expect(body.settlement.facilitator).toBe('https://facilitator.example/x402');
  });

  it('binds the payment to an absolute resource, not a path', () => {
    expect(body.accepts[0]!.resource).toBe('https://oracle.sb4s.xyz/quote');
  });

  it('carries the EIP-712 domain the authorization must be signed against', () => {
    expect(body.accepts[0]!.extra).toMatchObject({ name: 'USD Coin', version: '2' });
  });

  it('tells a caller where and how much to pay without reading docs', () => {
    // $0.02 at 6 decimals, on both schemes -- one price for every priced route.
    for (const accept of body.accepts) {
      expect(accept.maxAmountRequired).toBe('20000');
      expect(accept.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  /**
   * v1 calls the price `maxAmountRequired`; the v2 bodies Bankr's own
   * endpoints emit call it `amount`. A client reading the other key would find
   * nothing, so both carry the same number.
   */
  it('carries the price under both spellings', () => {
    for (const accept of body.accepts) {
      expect(accept.amount).toBe(accept.maxAmountRequired);
    }
  });

  it('still offers the credit scheme, honestly named', () => {
    const credit = body.accepts.find((a) => a.scheme === LEGACY_SCHEME);
    expect(credit).toBeDefined();
    expect(credit!.assetSymbol).toBe('USDC');
    expect(body.settlement.howToPay).toMatch(/no minimum/i);
  });

  /** One price, so a caller reading one route's 402 is right about all of them. */
  it('prices every priced route the same', () => {
    expect(payment402Body('/ask', DOMAIN).accepts[0]!.maxAmountRequired).toBe('20000');
    expect(payment402Body('/gas', DOMAIN).accepts[0]!.maxAmountRequired).toBe('20000');
  });

  it('lists exact and the credit scheme, in that order', () => {
    expect(requirementsFor('/quote', DOMAIN).map((a) => a.scheme)).toEqual([
      'exact',
      LEGACY_SCHEME,
    ]);
  });
});

describe('reading the X-PAYMENT header', () => {
  it('recognises a transaction hash as a top-up', () => {
    const res = readPaymentHeader(`0x${'a'.repeat(64)}`);
    expect(res.kind).toBe('txHash');
  });

  it('recognises a bare address as drawing on credit', () => {
    expect(readPaymentHeader(PAYER)).toEqual({ kind: 'payer', address: PAYER });
  });

  it('decodes a base64 x402 payload', () => {
    const payload = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { signature: '0xdead', authorization: { nonce: '0xBEEF' } },
    };
    const res = readPaymentHeader(Buffer.from(JSON.stringify(payload)).toString('base64'));
    expect(res.kind).toBe('exact');
    if (res.kind === 'exact') expect(res.payload.scheme).toBe('exact');
  });

  it('says what is wrong rather than failing as unpaid', () => {
    const res = readPaymentHeader(Buffer.from('not json at all').toString('base64'));
    expect(res.kind).toBe('unreadable');
  });

  it('treats a missing header as no payment', () => {
    expect(readPaymentHeader(undefined).kind).toBe('none');
  });
});

describe('a request from Bankr’s gateway', () => {
  const SECRET = '0123456789abcdef0123456789abcdef';
  const PAYER_ADDR = '0x4B19Ee2a3De2521A3aDc901989944c209C0a60eA';

  it('is trusted when the shared secret matches, and names the payer', () => {
    const res = readGatewayRequest({
      'x-bankr-secret': SECRET,
      'x-402-payer': PAYER_ADDR,
    });
    expect(res.trusted).toBe(true);
    expect(res.payer).toBe(PAYER_ADDR.toLowerCase());
  });

  /**
   * The header that says who paid is a plain string anyone can set. Trusting
   * it on its own would turn the payment wall into decoration.
   */
  it('ignores a payer header presented without the secret', () => {
    const res = readGatewayRequest({ 'x-402-payer': PAYER_ADDR });
    expect(res.trusted).toBe(false);
    expect(res.payer).toBeNull();
    expect(res.reason).toMatch(/x-bankr-secret/);
  });

  it('refuses a wrong secret, and says so distinctly', () => {
    const res = readGatewayRequest({ 'x-bankr-secret': `${SECRET.slice(0, -1)}0` });
    expect(res.trusted).toBe(false);
    expect(res.reason).toMatch(/did not match/);
  });

  it('leaves an ordinary call alone', () => {
    expect(readGatewayRequest({}).reason).toBe('not a gateway request');
  });

  /** The money is collected either way, so a malformed payer is dropped, not refused. */
  it('still serves a settled request whose payer header is malformed', () => {
    const res = readGatewayRequest({ 'x-bankr-secret': SECRET, 'x-402-payer': 'not-an-address' });
    expect(res.trusted).toBe(true);
    expect(res.payer).toBeNull();
  });
});

describe('the 402 points at the gateway too', () => {
  it('names where a Bankr caller should call instead', () => {
    const body = payment402Body('/quote', DOMAIN);
    expect(body.settlement.bankrGateway).toMatchObject({
      url: 'https://x402.bankr.bot/0x4b19ee2a3de2521a3adc901989944c209c0a60ea/vates',
      trustedByOrigin: true,
    });
  });
});

describe('one transaction buys one thing', () => {
  const HASH = `0x${'b'.repeat(64)}`;

  const record = (purpose: string) =>
    getDb()
      .prepare(
        `INSERT INTO payments (tx_hash, chain_id, payer, amount, claimed_at, expires_at, purpose)
         VALUES (?, 8453, ?, '1000000', ?, ?, ?)`,
      )
      .run(HASH, PAYER, Date.now(), Date.now() + 86_400_000, purpose);

  it('will not let a credit top-up be re-spent on a pro period', async () => {
    record('credit');
    const res = await claimPayment(HASH);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/credit/);
  });

  it('will not let a pro payment be re-spent on credit', async () => {
    record('pro');
    const res = await claimCredit(HASH);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/pro period/);
  });

  it('reports an already-claimed credit top-up as claimed, not as an error', async () => {
    record('credit');
    const res = await claimCredit(HASH);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.alreadyClaimed).toBe(true);
      // The amount actually transferred, in base units -- not a two-decimal
      // rendering of it, which is what used to be credited.
      expect(res.creditedUnits).toBe('1000000');
    }
  });
});
