import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Whether `exact` may honestly be advertised.
 *
 * The bug this covers was not a crash: the 402 offered `exact` because
 * X402_FACILITATOR_URL was set, and the facilitator it named settled only
 * testnets. Every authorization signed against that body would have been
 * refused for a reason the caller could not act on. So the question under test
 * is the one the code now asks -- not "is a facilitator configured" but "will
 * that facilitator settle this".
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'settleable-')), 'test.db');
process.env.X402_FACILITATOR_URL = 'https://facilitator.example/x402';
process.env.X402_RESOURCE_BASE = 'https://oracle.sb4s.xyz';
process.env.X402_NETWORK = 'base';

const { exactSettlement, refreshSettlement, resetSettlement } = await import(
  '../src/payments/settleable.js'
);
const { requirementsFor, payment402Body } = await import('../src/api/x402.js');
const { supports } = await import('../src/payments/facilitator.js');

const DOMAIN = { name: 'USD Coin', version: '2', source: 'fallback' as const };
const realFetch = globalThis.fetch;

let answer: () => Response | Promise<Response>;
let calls = 0;

globalThis.fetch = (async () => {
  calls += 1;
  return answer();
}) as unknown as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
});

const kinds = (k: unknown) =>
  () => new Response(JSON.stringify({ kinds: k }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** What x402.org actually answered: eight testnets and no Base mainnet. */
const TESTNETS_ONLY = [
  { scheme: 'exact', network: 'eip155:84532' },
  { scheme: 'upto', network: 'eip155:84532' },
  { scheme: 'exact', network: 'solana-devnet' },
  { scheme: 'exact', network: 'base-sepolia' },
];

beforeEach(() => {
  resetSettlement();
  calls = 0;
});

describe('asking the facilitator what it settles', () => {
  it('advertises exact when the facilitator settles it on this network', async () => {
    answer = kinds([{ scheme: 'exact', network: 'base' }]);
    await refreshSettlement();

    expect(exactSettlement().advertise).toBe(true);
    expect(requirementsFor('/quote', DOMAIN).map((r) => r.scheme)).toEqual([
      'exact',
      'onchain-transfer-credit',
    ]);
  });

  /** The failure that prompted this: a real answer from a real facilitator. */
  it('does not advertise exact when the facilitator only settles testnets', async () => {
    answer = kinds(TESTNETS_ONLY);
    await refreshSettlement();

    const verdict = exactSettlement();
    expect(verdict.advertise).toBe(false);
    expect(verdict.reason).toMatch(/does not settle exact on base/);
    expect(requirementsFor('/quote', DOMAIN).some((r) => r.scheme === 'exact')).toBe(false);
  });

  it('does not advertise exact when the facilitator cannot be reached', async () => {
    answer = () => {
      throw new Error('connect ECONNREFUSED');
    };
    await refreshSettlement();

    expect(exactSettlement().advertise).toBe(false);
    expect(exactSettlement().reason).toMatch(/could not be asked/);
  });

  /** Fail closed: silence is not consent. */
  it('does not advertise exact before the facilitator has answered at all', () => {
    answer = kinds([{ scheme: 'exact', network: 'base' }]);
    const verdict = exactSettlement();
    expect(verdict.advertise).toBe(false);
    expect(verdict.reason).toMatch(/has not answered yet/);
  });

  it('asks once and serves the answer from cache', async () => {
    answer = kinds([{ scheme: 'exact', network: 'base' }]);
    await refreshSettlement();
    for (let i = 0; i < 5; i += 1) exactSettlement();
    expect(calls).toBe(1);
  });

  it('shares one probe between concurrent callers', async () => {
    answer = kinds([{ scheme: 'exact', network: 'base' }]);
    await Promise.all([refreshSettlement(), refreshSettlement(), refreshSettlement()]);
    expect(calls).toBe(1);
  });
});

describe('the 402 body when exact is not settleable', () => {
  it('says why rather than silently omitting the scheme', async () => {
    answer = kinds(TESTNETS_ONLY);
    await refreshSettlement();

    const body = payment402Body('/quote', DOMAIN);
    expect(body.settlement.standardX402).toBe(false);
    expect(body.settlement.standardX402Note).toMatch(/does not settle exact on base/);
  });

  /**
   * Refusing to advertise is not refusing to be paid. Two doors remain, and
   * the body must still name them -- a caller that reads "no exact" and stops
   * is a caller lost to a scheme it never needed.
   */
  it('still names the credit scheme and the gateway', async () => {
    answer = kinds(TESTNETS_ONLY);
    await refreshSettlement();

    const body = payment402Body('/quote', DOMAIN);
    expect(body.accepts[0]!.scheme).toBe('onchain-transfer-credit');
    expect(body.settlement.howToPay).toMatch(/no minimum/i);
  });
});

describe('one network under its several names', () => {
  /**
   * The same facilitator listed base-sepolia as both `eip155:84532` and
   * `base-sepolia`. Comparing strings would make a facilitator that does
   * settle on Base look like one that does not, and hide a working door.
   */
  it('matches base against its CAIP-2 spelling', () => {
    expect(supports([{ scheme: 'exact', network: 'eip155:8453' }], 'exact', 'base')).toBe(true);
    expect(supports([{ scheme: 'exact', network: 'base' }], 'exact', 'base')).toBe(true);
  });

  it('does not match Base against Base Sepolia under either spelling', () => {
    expect(supports([{ scheme: 'exact', network: 'eip155:84532' }], 'exact', 'base')).toBe(false);
    expect(supports([{ scheme: 'exact', network: 'base-sepolia' }], 'exact', 'base')).toBe(false);
  });

  it('leaves a network it has never heard of compared exactly', () => {
    expect(supports([{ scheme: 'exact', network: 'avalanche' }], 'exact', 'avalanche')).toBe(true);
    expect(supports([{ scheme: 'exact', network: 'avalanche' }], 'exact', 'base')).toBe(false);
  });
});
