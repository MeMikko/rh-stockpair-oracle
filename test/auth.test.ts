import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'auth-')), 'test.db');
process.env.AUTH_SECRET = 'test-secret-at-least-16-chars-long';

const { getDb } = await import('../src/db/index.js');
const { grant } = await import('../src/entitlements/index.js');
const {
  issueNonce, verifySignIn, readSession, mintSession, signInMessage, tierForSession,
} = await import('../src/auth/session.js');

// A fixed key so the address is stable across runs; it holds nothing.
const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const signIn = async (nonce: string) =>
  verifySignIn({
    address: account.address,
    nonce,
    signature: await account.signMessage({ message: signInMessage(account.address.toLowerCase(), nonce) }),
  });

beforeEach(() => {
  getDb().exec('DELETE FROM auth_nonces');
  getDb().exec('DELETE FROM entitlements');
});

describe('sign-in', () => {
  it('accepts a signature over the exact message we asked for', async () => {
    const res = await signIn(issueNonce());
    expect(res.ok).toBe(true);
  });

  /** Without single use, a captured signature is a permanent credential. */
  it('refuses to spend the same nonce twice', async () => {
    const nonce = issueNonce();
    const sig = await account.signMessage({
      message: signInMessage(account.address.toLowerCase(), nonce),
    });
    expect((await verifySignIn({ address: account.address, signature: sig, nonce })).ok).toBe(true);
    const replay = await verifySignIn({ address: account.address, signature: sig, nonce });
    expect(replay.ok).toBe(false);
    expect(replay).toHaveProperty('error', 'nonce already used');
  });

  it('rejects a nonce it never issued', async () => {
    const res = await verifySignIn({ address: account.address, signature: '0x00', nonce: 'made-up' });
    expect(res).toHaveProperty('error', 'unknown nonce');
  });

  it('rejects a signature from a different address', async () => {
    const other = privateKeyToAccount(
      '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
    );
    const nonce = issueNonce();
    const res = await verifySignIn({
      address: account.address,
      nonce,
      signature: await other.signMessage({
        message: signInMessage(account.address.toLowerCase(), nonce),
      }),
    });
    expect(res).toHaveProperty('error', 'signature does not match that address');
  });

  it('does not burn the nonce on a bad signature', async () => {
    const nonce = issueNonce();
    await verifySignIn({ address: account.address, signature: '0x1234', nonce });
    // The user must be able to retry with the same nonce after a wallet error.
    expect((await signIn(nonce)).ok).toBe(true);
  });
});

describe('session tokens', () => {
  it('round-trips', () => {
    const s = readSession(mintSession(account.address))!;
    expect(s.subject).toBe(account.address.toLowerCase());
  });

  it('rejects a tampered payload', () => {
    const token = mintSession(account.address);
    const [, mac] = token.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ t: 'address', s: '0x' + '1'.repeat(40), e: Date.now() + 10_000 }),
    ).toString('base64url')}.${mac}`;
    expect(readSession(forged)).toBeNull();
  });

  it('rejects an expired token', () => {
    const body = Buffer.from(
      JSON.stringify({ t: 'address', s: account.address.toLowerCase(), e: Date.now() - 1 }),
    ).toString('base64url');
    expect(readSession(`${body}.whatever`)).toBeNull();
  });
});

describe('tierForSession', () => {
  it('is free without a session, whatever is claimed', () => {
    grant('address', account.address);
    const t = tierForSession(undefined);
    expect(t.tier).toBe('free');
    expect(t.reason).toMatch(/not signed in/);
  });

  it('applies an entitlement once the address is proved', () => {
    grant('address', account.address);
    expect(tierForSession(mintSession(account.address)).tier).toBe('pro');
  });

  it('a proved address with no entitlement is still free', () => {
    expect(tierForSession(mintSession(account.address)).tier).toBe('free');
  });
});
