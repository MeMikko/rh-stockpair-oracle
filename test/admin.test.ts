import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'admin-')), 'test.db');
// Deliberately different from AUTH_SECRET below: the point of the admin
// session is that the public site cannot mint one.
process.env.AUTH_SECRET = 'public-secret-at-least-16-chars';
process.env.ADMIN_AUTH_SECRET = 'admin-secret-at-least-16-chars';

// A fixed key, stable across runs, holding nothing.
const owner = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);
const stranger = privateKeyToAccount(
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
);
process.env.ADMIN_ADDRESSES = owner.address.toLowerCase();

const { getDb } = await import('../src/db/index.js');
const {
  adminConfig, adminConfigured, adminSignInMessage, isOwner,
  issueAdminNonce, mintAdminSession, readAdminSession, verifyAdminSignIn,
} = await import('../src/admin/auth.js');
const { mintSession, signInMessage, issueNonce } = await import('../src/auth/session.js');
const { buildAdminServer } = await import('../src/admin/server.js');
const { assertLlmOnlyProcess } = await import('../config/bankr.js');

const signInAs = async (account: typeof owner, nonce: string) =>
  verifyAdminSignIn({
    address: account.address,
    nonce,
    signature: await account.signMessage({
      message: adminSignInMessage(account.address.toLowerCase(), nonce),
    }),
  });

beforeEach(() => {
  getDb().exec('DELETE FROM auth_nonces');
});

describe('admin sign-in', () => {
  it('admits an address on the allowlist', async () => {
    const res = await signInAs(owner, issueAdminNonce());
    expect(res.ok).toBe(true);
    if (res.ok) expect(readAdminSession(res.token)?.subject).toBe(owner.address.toLowerCase());
  });

  /**
   * The whole reason this module exists rather than reusing the public
   * session: proving you control an address is not the same as being the
   * operator.
   */
  it('refuses a valid signature from an address that is not an owner', async () => {
    const res = await signInAs(stranger, issueAdminNonce());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ADMIN_ADDRESSES/);
  });

  /**
   * A session minted by the public server must be worthless here even for the
   * owner's own address — otherwise the panel inherits the public site's
   * threat model.
   */
  it('rejects a public-site session token', () => {
    const publicToken = mintSession(owner.address);
    expect(readAdminSession(publicToken)).toBeNull();
  });

  /**
   * And a signature captured from the public sign-in must not be replayable
   * here: the two messages say different things, so one cannot stand in for
   * the other.
   */
  it('rejects a signature over the public sign-in message', async () => {
    const nonce = issueNonce();
    const res = await verifyAdminSignIn({
      address: owner.address,
      nonce,
      signature: await owner.signMessage({
        message: signInMessage(owner.address.toLowerCase(), nonce),
      }),
    });
    expect(res.ok).toBe(false);
  });

  it('spends a nonce once', async () => {
    const nonce = issueAdminNonce();
    expect((await signInAs(owner, nonce)).ok).toBe(true);
    expect((await signInAs(owner, nonce)).ok).toBe(false);
  });

  /**
   * Removing someone from ADMIN_ADDRESSES has to take effect immediately,
   * not when their twelve-hour token happens to expire.
   */
  it('stops honouring a live token once the address leaves the allowlist', () => {
    const token = mintAdminSession(owner.address);
    expect(readAdminSession(token)).not.toBeNull();
    const saved = adminConfig.owners.slice();
    adminConfig.owners.length = 0;
    try {
      expect(readAdminSession(token)).toBeNull();
    } finally {
      adminConfig.owners.push(...saved);
    }
  });

  it('is not configured when the allowlist is empty', () => {
    const saved = adminConfig.owners.slice();
    adminConfig.owners.length = 0;
    try {
      const res = adminConfigured();
      expect(res.ok).toBe(false);
    } finally {
      adminConfig.owners.push(...saved);
    }
    expect(isOwner(stranger.address)).toBe(false);
  });
});

describe('key separation', () => {
  /**
   * The guard that answers the question this was all built for: the process
   * serving the internet must not hold a credential that can move funds.
   */
  it('refuses to boot a public process holding the wallet-scoped key', () => {
    expect(() => assertLlmOnlyProcess()).not.toThrow();

    process.env.BANKR_API_KEY = 'bk_pretend_admin_key';
    try {
      expect(() => assertLlmOnlyProcess()).toThrow(/BANKR_API_KEY/);
    } finally {
      delete process.env.BANKR_API_KEY;
    }

    expect(() => assertLlmOnlyProcess()).not.toThrow();
  });
});

describe('the composer holds a person to the same rule as the model', () => {
  /**
   * The whole point of letting an operator write by hand is that it is not a
   * bypass. A number that is not in the facts is refused here exactly as it is
   * refused in a drafted post, and the refusal names the number.
   */
  it('refuses a hand-written post citing a number that is not in the facts', async () => {
    const app = buildAdminServer();
    app.log.level = 'silent';
    try {
      const nonceRes = await app.inject(`/admin/nonce?address=${owner.address}`);
      const { nonce, message } = JSON.parse(nonceRes.body) as { nonce: string; message: string };
      const verify = await app.inject({
        method: 'POST',
        url: '/admin/verify',
        payload: { address: owner.address, signature: await owner.signMessage({ message }), nonce },
      });
      const cookie = String(verify.headers['set-cookie']).split(';')[0]!;

      const bad = await app.inject({
        method: 'POST',
        url: '/admin/compose',
        headers: { cookie },
        payload: { text: 'We index 999999 stock-paired pools.' },
      });
      expect(bad.statusCode).toBe(400);
      expect(JSON.parse(bad.body).error).toContain('999999');

      // Over-length is a different failure and is reported as one, rather
      // than as an empty list of unsupported numbers.
      const long = await app.inject({
        method: 'POST',
        url: '/admin/compose',
        headers: { cookie },
        payload: { text: 'x'.repeat(400) },
      });
      expect(JSON.parse(long.body).error).toMatch(/too long/);

      const ok = await app.inject({
        method: 'POST',
        url: '/admin/compose',
        headers: { cookie },
        payload: { text: 'Stock-paired pools on Robinhood Chain, across both Uniswap versions.' },
      });
      expect(ok.statusCode).toBe(200);
      expect(JSON.parse(ok.body).post.draftedBy).toBe(`operator:${owner.address.toLowerCase()}`);

      // A queue keyed on one post per signal means the same note twice is a
      // conflict, not a second post.
      const again = await app.inject({
        method: 'POST',
        url: '/admin/compose',
        headers: { cookie },
        payload: { text: 'Stock-paired pools on Robinhood Chain, across both Uniswap versions.' },
      });
      expect(again.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  /** An unsigned caller reaches none of it. */
  it('refuses to compose without an owner session', async () => {
    const app = buildAdminServer();
    app.log.level = 'silent';
    try {
      const res = await app.inject({ method: 'POST', url: '/admin/compose', payload: { text: 'hi' } });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
