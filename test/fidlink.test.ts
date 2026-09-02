import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'fid-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const { grant, lookup } = await import('../src/entitlements/index.js');
const { linkFid, currentFidFor } = await import('../src/auth/farcaster.js');

const A = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const B = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

beforeEach(() => {
  getDb().exec('DELETE FROM fid_links');
  getDb().exec('DELETE FROM entitlements');
  // No Neynar key in tests: the lookup returns null, which must not block.
  delete process.env.NEYNAR_API_KEY;
});
afterEach(() => vi.unstubAllGlobals());

describe('linkFid', () => {
  it('requires a paid address', async () => {
    const r = await linkFid(A, '123');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/buy pro first/);
  });

  /** The claim is trusted; an unreachable verification must not block it. */
  it('links an unverified FID when the address has paid', async () => {
    grant('address', A, { expiresAt: Date.now() + 60_000 });
    const r = await linkFid(A, '123');
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(false);
    expect(lookup('fid', '123')?.tier).toBe('pro');
  });

  it('gives the FID the address existing expiry, not a fresh period', async () => {
    const expires = Date.now() + 12_345;
    grant('address', A, { expiresAt: expires });
    await linkFid(A, '123');
    expect(lookup('fid', '123')?.expiresAt).toBe(expires);
  });

  it('replaces the previous FID rather than accumulating', async () => {
    grant('address', A, { expiresAt: Date.now() + 60_000 });
    await linkFid(A, '111');
    const r = await linkFid(A, '222');
    expect(r.replaced).toBe('111');
    expect(lookup('fid', '111')).toBeNull();
    expect(lookup('fid', '222')?.tier).toBe('pro');
    expect(currentFidFor(A)).toBe('222');
  });

  /** Otherwise one payer could displace another's paid link. */
  it('refuses an FID another subscription already holds', async () => {
    grant('address', A, { expiresAt: Date.now() + 60_000 });
    grant('address', B, { expiresAt: Date.now() + 60_000 });
    await linkFid(A, '777');
    const r = await linkFid(B, '777');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already linked/);
  });

  it('refuses an expired entitlement', async () => {
    grant('address', A, { expiresAt: Date.now() - 1 });
    expect((await linkFid(A, '123')).error).toMatch(/expired/);
  });

  it('records verification when the FID did verify the address', async () => {
    process.env.NEYNAR_API_KEY = 'k';
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ users: [{ verified_addresses: { eth_addresses: [A] } }] })),
    );
    grant('address', A, { expiresAt: Date.now() + 60_000 });
    const r = await linkFid(A, '123');
    expect(r.ok).toBe(true);
    expect(r.verified).toBe(true);
    expect(lookup('fid', '123')?.source).toMatch(/verified/);
  });
});
