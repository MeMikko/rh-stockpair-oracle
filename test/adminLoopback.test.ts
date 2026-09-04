import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The same panel on loopback, which is still the default.
 *
 * Exposing it must not have quietly hardened the local case into
 * unusability: over an SSH tunnel the panel is plain http, where a `Secure`
 * cookie is simply never sent — a broken login that looks like a security
 * setting. And the specific sign-in error is worth keeping where the only
 * person who can read it is the operator mistyping their own address.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'admin-loopback-')), 'test.db');
process.env.ADMIN_HOST = '127.0.0.1';
process.env.ADMIN_AUTH_SECRET = 'y'.repeat(20);
process.env.ADMIN_ADDRESSES = '0x4b19ee2a3de2521a3adc901989944c209c0a60ea';
delete process.env.ADMIN_ALLOW_REMOTE;
delete process.env.ADMIN_SECURE_COOKIE;

const {
  adminExposure, adminExposureConfig, remoteReadiness, secureCookie, sessionTtlMs, signInError,
} = await import('../src/admin/exposure.js');
const { adminConfig } = await import('../src/admin/auth.js');
const { buildAdminServer } = await import('../src/admin/server.js');

const app = buildAdminServer();
afterAll(async () => { await app.close(); });

describe('loopback is unchanged', () => {
  it('is the mode when the host is loopback', () => {
    expect(adminExposure()).toBe('loopback');
  });

  /** A 20-character secret is short for the internet and fine for a tunnel. */
  it('does not apply the exposed-panel checks', () => {
    expect(remoteReadiness()).toEqual({ ok: true });
  });

  it('leaves the cookie unsecured, because the tunnel is http', () => {
    expect(secureCookie()).toBe(false);
  });

  it('keeps the longer session', () => {
    expect(sessionTtlMs()).toBe(12 * 3_600_000);
  });

  it('still says exactly what went wrong at sign-in', () => {
    expect(signInError('that address is not in ADMIN_ADDRESSES')).toMatch(/ADMIN_ADDRESSES/);
  });

  it('still answers the diagnostic health route in full', async () => {
    const body = (await app.inject({ method: 'GET', url: '/admin/health' })).json();
    expect(body.owners).toBe(1);
    expect(body).toHaveProperty('adminKey');
  });

  /** Pinning a browser to https for localhost would break other local services. */
  it('does not send HSTS', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/health' });
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('binding somewhere else without saying so', () => {
  /**
   * The guard that has always existed, now doing more than moving a port: the
   * same switch is what turns on every hardening in exposure.ts, so leaving it
   * off while binding outward has to stay a refusal to start.
   */
  it('is refused', () => {
    const before = adminExposureConfig.host;
    adminExposureConfig.host = '0.0.0.0';
    try {
      expect((remoteReadiness() as { error: string }).error).toMatch(/refusing to bind/);
    } finally {
      adminExposureConfig.host = before;
    }
  });

  it('is allowed once the operator says so, with a strong enough secret', () => {
    const beforeHost = adminExposureConfig.host;
    const beforeAllow = adminExposureConfig.allowRemote;
    const auth = adminConfig;
    const beforeSecret = auth.secret;
    adminExposureConfig.host = '0.0.0.0';
    adminExposureConfig.allowRemote = true;
    auth.secret = 'z'.repeat(40);
    try {
      expect(remoteReadiness()).toEqual({ ok: true });
    } finally {
      adminExposureConfig.host = beforeHost;
      adminExposureConfig.allowRemote = beforeAllow;
      auth.secret = beforeSecret;
    }
  });
});
