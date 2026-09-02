import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'ent-')), 'test.db');

const {
  grant, revoke, lookup, listEntitlements, resolve, normaliseSubject, InvalidSubject,
} = await import('../src/entitlements/index.js');
const { getDb } = await import('../src/db/index.js');

beforeEach(() => {
  getDb().exec('DELETE FROM entitlements');
});

describe('normaliseSubject', () => {
  it('canonicalises an address so one person cannot hold two rows', () => {
    // A correctly checksummed address, and its lowercase form, must be one key.
    const checksummed = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    expect(normaliseSubject('address', checksummed)).toBe(checksummed.toLowerCase());
    expect(normaliseSubject('address', checksummed.toLowerCase())).toBe(checksummed.toLowerCase());
  });

  it('accepts an all-lowercase address, which carries no checksum to verify', () => {
    const lower = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
    expect(normaliseSubject('address', lower)).toBe(lower);
  });

  it('rejects a mixed-case address whose checksum does not match', () => {
    // Mixed case claims to be checksummed, so a mismatch is a typo -- and a
    // typo grants pro to an address nobody controls.
    expect(() => normaliseSubject('address', '0x5Fc5360D0400a0Fd4f2af552ADD042D716F1d168')).toThrow(
      InvalidSubject,
    );
  });

  it('strips leading zeros from an FID for the same reason', () => {
    expect(normaliseSubject('fid', '000123')).toBe('123');
  });

  it('rejects anything that is not a subject', () => {
    expect(() => normaliseSubject('address', '0xnope')).toThrow(InvalidSubject);
    expect(() => normaliseSubject('fid', '12a')).toThrow(InvalidSubject);
  });
});

describe('grant and revoke', () => {
  it('stores and returns an entitlement', () => {
    const e = grant('fid', '4321', { note: 'tester' });
    expect(e.tier).toBe('pro');
    expect(lookup('fid', '4321')?.note).toBe('tester');
  });

  it('re-granting updates rather than duplicating', () => {
    grant('fid', '4321', { source: 'manual' });
    grant('fid', '4321', { source: 'payment:0xabc' });
    expect(listEntitlements(true)).toHaveLength(1);
    expect(lookup('fid', '4321')?.source).toBe('payment:0xabc');
  });

  it('revoke removes it, whatever case the caller uses', () => {
    grant('address', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
    expect(revoke('address', '0x5fc5360d0400a0fd4f2af552add042d716f1d168')).toBe(true);
    expect(lookup('address', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')).toBeNull();
  });
});

/**
 * The security property this table exists to hold. A claimed identity must
 * never inherit an entitlement, or any HTTP caller could send someone else's
 * FID and become pro.
 */
describe('resolve', () => {
  it('grants pro only to a verified subject', () => {
    grant('fid', '77');
    expect(resolve('fid', '77', 'verified').tier).toBe('pro');
    expect(resolve('fid', '77', 'claimed').tier).toBe('free');
  });

  it('says why a claimed identity was refused', () => {
    grant('fid', '77');
    expect(resolve('fid', '77', 'claimed').reason).toMatch(/not verified/i);
  });

  it('treats an expired entitlement as free', () => {
    grant('fid', '88', { expiresAt: Date.now() - 1000 });
    const r = resolve('fid', '88', 'verified');
    expect(r.tier).toBe('free');
    expect(r.reason).toMatch(/expired/i);
  });

  it('honours an unexpired one', () => {
    grant('fid', '99', { expiresAt: Date.now() + 60_000 });
    expect(resolve('fid', '99', 'verified').tier).toBe('pro');
  });

  it('is free for an unknown subject, and for a malformed one', () => {
    expect(resolve('fid', '12345', 'verified').tier).toBe('free');
    expect(resolve('address', 'garbage', 'verified').tier).toBe('free');
    expect(resolve('address', 'garbage', 'verified').reason).toMatch(/malformed/);
  });
});

describe('listEntitlements', () => {
  it('hides expired rows unless asked', () => {
    grant('fid', '1', { expiresAt: Date.now() - 1 });
    grant('fid', '2', { expiresAt: null });
    expect(listEntitlements()).toHaveLength(1);
    expect(listEntitlements(true)).toHaveLength(2);
  });
});
