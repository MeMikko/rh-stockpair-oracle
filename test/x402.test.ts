import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'x402-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const { creditBalance, addCredit, spendCredit, paymentRequirements } = await import(
  '../src/api/x402.js'
);

const PAYER = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

beforeEach(() => {
  getDb().exec('DELETE FROM x402_credits');
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
  const req = paymentRequirements('/quote');

  it('tells a caller where and how much to pay without reading docs', () => {
    const accept = req.accepts[0]!;
    expect(accept.network).toBe('base');
    expect(accept.chainId).toBe(8453);
    expect(accept.assetSymbol).toBe('USDC');
    // $0.01 at 6 decimals.
    expect(accept.maxAmountRequired).toBe('10000');
    expect(accept.payTo).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('states that a transfer buys credit rather than one call', () => {
    // The part that differs from a naive reading of x402, so it must be in
    // the response and not only in prose somewhere.
    expect(req.settlement.mode).toBe('prepaid-credit');
    expect(req.settlement.howToPay).toMatch(/credit/i);
  });

  it('prices the cheaper routes lower', () => {
    expect(paymentRequirements('/ask').accepts[0]!.maxAmountRequired).toBe('5000');
  });
});
