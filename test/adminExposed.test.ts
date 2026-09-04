import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The operator panel with the internet in front of it.
 *
 * Three of this panel's decisions were written down as safe *because* it was
 * unreachable: a sign-in error that names whether an address is an owner, a
 * cookie without `Secure`, and no bound at all on the routes that must stay
 * open to sign in. Publishing it makes each of those wrong, and this file is
 * the check that each one actually changed rather than being described as
 * changed in a comment.
 *
 * Its own file because the exposure mode is read from the environment when the
 * module loads, so one process cannot hold both modes.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'admin-exposed-')), 'test.db');
process.env.ADMIN_HOST = '172.18.0.1';
process.env.ADMIN_ALLOW_REMOTE = '1';
process.env.ADMIN_AUTH_SECRET = 'x'.repeat(48);
process.env.ADMIN_ADDRESSES = '0x4b19ee2a3de2521a3adc901989944c209c0a60ea';
delete process.env.ADMIN_SECURE_COOKIE;

const {
  adminExposure, remoteReadiness, secureCookie, sessionTtlMs, signInError,
} = await import('../src/admin/exposure.js');
const { checkLimit, resetLimits } = await import('../src/admin/rateLimit.js');
const { buildAdminServer } = await import('../src/admin/server.js');

const app = buildAdminServer();
afterAll(async () => { await app.close(); });
beforeEach(() => resetLimits());

describe('the exposure mode itself', () => {
  it('knows it is not on loopback', () => {
    expect(adminExposure()).toBe('remote');
  });

  it('forces Secure on the cookie rather than leaving it to a default', () => {
    // The env var is unset. On loopback that means "not secure"; here it must
    // not be able to mean that at all.
    expect(secureCookie()).toBe(true);
  });

  it('shortens the session, because a stolen cookie now travels', () => {
    expect(sessionTtlMs()).toBe(2 * 3_600_000);
  });

  it('stops saying which addresses are owners', () => {
    expect(signInError('that address is not in ADMIN_ADDRESSES')).toBe('sign-in failed');
  });
});

describe('refusing to start', () => {
  const withEnv = (patch: Record<string, string | undefined>, fn: () => void) => {
    const before = { ...process.env };
    Object.assign(process.env, patch);
    try { fn(); } finally {
      for (const k of Object.keys(patch)) delete process.env[k];
      Object.assign(process.env, before);
    }
  };

  /**
   * 16 characters is enough for a secret nobody can reach. A secret anyone can
   * attack offline, guarding a panel that reaches a wallet, is not the same
   * problem — so the floor is higher here and checked at boot.
   */
  it('rejects a secret that would be fine on loopback', async () => {
    const mod = await import('../src/admin/auth.js');
    const original = mod.adminConfig.secret;
    (mod.adminConfig as { secret: string }).secret = 'x'.repeat(16);
    expect(remoteReadiness()).toMatchObject({ ok: false });
    expect((remoteReadiness() as { error: string }).error).toMatch(/at least 32 characters/);
    (mod.adminConfig as { secret: string }).secret = original;
  });

  it('rejects an explicit attempt to unset Secure', () => {
    withEnv({ ADMIN_SECURE_COOKIE: '0' }, () => {
      expect((remoteReadiness() as { error: string }).error).toMatch(/plain HTTP/);
    });
  });

  it('is satisfied when everything is in place', () => {
    expect(remoteReadiness()).toEqual({ ok: true });
  });
});

describe('the doors that must stay open', () => {
  it('bounds nonce issuance', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 33; i += 1) {
      codes.push((await app.inject({ method: 'GET', url: '/admin/nonce' })).statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes[0]).toBe(200);
  });

  it('bounds signature verification more tightly than nonce issuance', async () => {
    const body = { address: '0x' + '1'.repeat(40), signature: '0xdead', nonce: 'n' };
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      codes.push((await app.inject({ method: 'POST', url: '/admin/verify', payload: body })).statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
  });

  it('says when to come back rather than only refusing', async () => {
    for (let i = 0; i < 40; i += 1) await app.inject({ method: 'GET', url: '/admin/nonce' });
    const res = await app.inject({ method: 'GET', url: '/admin/nonce' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  /** A limit that locks out the operator would be a denial of service on them. */
  it('lets the same caller back in once the window passes', () => {
    const limit = { events: 2, windowMs: 1000 };
    expect(checkLimit('k', limit, 0).ok).toBe(true);
    expect(checkLimit('k', limit, 0).ok).toBe(true);
    expect(checkLimit('k', limit, 0).ok).toBe(false);
    expect(checkLimit('k', limit, 1001).ok).toBe(true);
  });
});

describe('what an unauthenticated caller learns', () => {
  it('gets liveness from /admin/health and nothing about the deployment', async () => {
    const body = (await app.inject({ method: 'GET', url: '/admin/health' })).json();
    expect(body).toEqual({ ok: true });
    expect(body.owners).toBeUndefined();
    expect(body.adminKey).toBeUndefined();
  });

  it('is not told whether a wallet-capable key is loaded', async () => {
    const body = (await app.inject({ method: 'GET', url: '/admin/me' })).json();
    expect(body.signedIn).toBe(false);
    expect(body.adminKey).toBeNull();
  });

  it('cannot reach a gated route', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/queue' })).statusCode).toBe(401);
  });
});

describe('response headers', () => {
  it('sends HSTS once the panel is published', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/health' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
  });

  it('still refuses to be framed or cached', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/health' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
