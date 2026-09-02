import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'auto-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const { grant } = await import('../src/entitlements/index.js');
const { decide, recordAutoReply, autonomyConfig, repliesToFidToday, repliesToday } = await import(
  '../src/agent/autonomy.js'
);

const PRO = '4242';
const defaults = { ...autonomyConfig };

beforeEach(() => {
  getDb().exec('DELETE FROM auto_replies');
  getDb().exec('DELETE FROM entitlements');
  Object.assign(autonomyConfig, defaults, { mode: 'pro', selfFid: '1' });
  grant('fid', PRO);
});

afterEach(() => {
  Object.assign(autonomyConfig, defaults);
});

/**
 * Every gate defaults closed. These tests exist because the failure mode is
 * an agent posting to a public timeline without anyone having seen it, which
 * cannot be undone by fixing the code afterwards.
 */
describe('autonomy gate', () => {
  it('is off unless explicitly enabled', () => {
    autonomyConfig.mode = 'off';
    const d = decide({ fid: PRO, answered: true });
    expect(d.autonomous).toBe(false);
    expect(d.reason).toMatch(/off/);
  });

  it('answers an entitled FID when enabled', () => {
    expect(decide({ fid: PRO, answered: true }).autonomous).toBe(true);
  });

  it('queues a FID with no entitlement', () => {
    const d = decide({ fid: '999', answered: true });
    expect(d.autonomous).toBe(false);
    expect(d.reason).toMatch(/free/);
  });

  it('says nothing when the question is not answerable', () => {
    const d = decide({ fid: PRO, answered: false });
    expect(d.autonomous).toBe(false);
    expect(d.reason).toMatch(/not answerable/);
  });

  it('refuses to reply to itself', () => {
    grant('fid', '1');
    const d = decide({ fid: '1', answered: true });
    expect(d.autonomous).toBe(false);
    expect(d.reason).toMatch(/loop/);
  });

  it('refuses when the mention carries no FID', () => {
    expect(decide({ fid: null, answered: true }).autonomous).toBe(false);
  });

  it('stops one person monopolising it', () => {
    autonomyConfig.perFidDaily = 2;
    for (let i = 0; i < 2; i++) {
      recordAutoReply({ castHash: `0xa${i}`, fid: PRO, intent: 'pools', ref: null });
    }
    expect(repliesToFidToday(PRO)).toBe(2);
    const d = decide({ fid: PRO, answered: true });
    expect(d.autonomous).toBe(false);
    expect(d.reason).toMatch(/limit 2/);
  });

  it('stops at the global daily cap even for a fresh FID', () => {
    autonomyConfig.dailyCap = 3;
    for (let i = 0; i < 3; i++) {
      recordAutoReply({ castHash: `0xb${i}`, fid: String(1000 + i), intent: 'pools', ref: null });
    }
    grant('fid', '5555');
    expect(repliesToday()).toBe(3);
    expect(decide({ fid: '5555', answered: true }).reason).toMatch(/daily cap/);
  });

  it('an expired entitlement stops being answered', () => {
    grant('fid', '7777', { expiresAt: Date.now() - 1 });
    expect(decide({ fid: '7777', answered: true }).autonomous).toBe(false);
  });

  it('does not count replies older than the window', () => {
    autonomyConfig.perFidDaily = 1;
    getDb()
      .prepare('INSERT INTO auto_replies (cast_hash, fid, replied_at, intent, ref) VALUES (?,?,?,?,?)')
      .run('0xold', PRO, Date.now() - 2 * 86_400_000, 'pools', null);
    expect(repliesToFidToday(PRO)).toBe(0);
    expect(decide({ fid: PRO, answered: true }).autonomous).toBe(true);
  });
});

describe('recordAutoReply', () => {
  it('records one row per cast, so a restart cannot double-answer', () => {
    recordAutoReply({ castHash: '0xsame', fid: PRO, intent: 'pools', ref: 'r1' });
    recordAutoReply({ castHash: '0xsame', fid: PRO, intent: 'pools', ref: 'r2' });
    expect(repliesToFidToday(PRO)).toBe(1);
  });
});
