import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The paid path, end to end, against a facilitator that is stubbed rather than
 * called.
 *
 * What is worth testing here is not the arithmetic -- it is the shape of the
 * request sent to the facilitator, and what happens when the facilitator says
 * no. Both were previously untestable, because there was no facilitator at
 * all: the 402 named a scheme nobody implemented.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'x402-fac-')), 'test.db');
process.env.X402_FACILITATOR_URL = 'https://facilitator.example/x402';
process.env.X402_FACILITATOR_KEY = 'test-key';
process.env.X402_RESOURCE_BASE = 'https://oracle.sb4s.xyz';

const {
  verifyPayment, settlePayment, facilitatorSupported, supports, FacilitatorUnavailable,
} = await import('../src/payments/facilitator.js');

const PAYLOAD = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base',
  payload: { signature: '0xdead', authorization: { nonce: '0xbeef' } },
};

const REQUIREMENTS = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '10000',
  resource: 'https://oracle.sb4s.xyz/quote',
  description: 'One call to /quote',
  mimeType: 'application/json',
  payTo: '0x8520B3693a2Cf3c2bEa3a505Af3A9c1b093954c7',
  maxTimeoutSeconds: 120,
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};

const calls: Array<{ url: string; init?: RequestInit }> = [];
const realFetch = globalThis.fetch;

function stub(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls.length = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('verify', () => {
  it('sends the payload and the requirements it was quoted against', async () => {
    stub(200, { isValid: true, payer: '0xabc' });
    const res = await verifyPayment(PAYLOAD, REQUIREMENTS);

    expect(res.isValid).toBe(true);
    expect(calls[0]!.url).toBe('https://facilitator.example/x402/verify');
    const sent = JSON.parse(String(calls[0]!.init!.body));
    expect(sent).toMatchObject({
      x402Version: 1,
      paymentPayload: PAYLOAD,
      paymentRequirements: { resource: 'https://oracle.sb4s.xyz/quote' },
    });
    expect((calls[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('test-key');
  });

  /**
   * A facilitator that answers `valid` rather than `isValid` used to read as a
   * refusal. Refusing a caller who paid is the expensive direction of this
   * mistake, so both spellings are accepted.
   */
  it('accepts either spelling of the verdict', async () => {
    stub(200, { valid: true });
    expect((await verifyPayment(PAYLOAD, REQUIREMENTS)).isValid).toBe(true);
  });

  it('passes the refusal reason through rather than inventing one', async () => {
    stub(200, { isValid: false, invalidReason: 'insufficient_funds' });
    const res = await verifyPayment(PAYLOAD, REQUIREMENTS);
    expect(res.isValid).toBe(false);
    expect(res.invalidReason).toBe('insufficient_funds');
  });

  it('reports an unreachable facilitator as unavailable, not as a bad payment', async () => {
    stub(500, { error: 'nope' });
    await expect(verifyPayment(PAYLOAD, REQUIREMENTS)).rejects.toBeInstanceOf(
      FacilitatorUnavailable,
    );
  });
});

describe('settle', () => {
  it('returns the settlement transaction under either field name', async () => {
    stub(200, { success: true, txHash: '0xfeed', network: 'base' });
    const res = await settlePayment(PAYLOAD, REQUIREMENTS);
    expect(res.success).toBe(true);
    expect(res.transaction).toBe('0xfeed');
    expect(calls[0]!.url).toBe('https://facilitator.example/x402/settle');
  });

  it('reports a refusal as a failure with its reason', async () => {
    stub(200, { success: false, errorReason: 'authorization_expired' });
    const res = await settlePayment(PAYLOAD, REQUIREMENTS);
    expect(res.success).toBe(false);
    expect(res.errorReason).toBe('authorization_expired');
  });
});

describe('supported', () => {
  it('reads the kinds a facilitator will settle', async () => {
    stub(200, { kinds: [{ x402Version: 1, scheme: 'exact', network: 'base' }] });
    const kinds = await facilitatorSupported();
    expect(supports(kinds, 'exact', 'base')).toBe(true);
    expect(supports(kinds, 'exact', 'solana')).toBe(false);
  });

  it('accepts a bare array as well as a wrapped one', async () => {
    stub(200, [{ scheme: 'exact', network: 'base' }]);
    expect(supports(await facilitatorSupported(), 'exact', 'base')).toBe(true);
  });
});
