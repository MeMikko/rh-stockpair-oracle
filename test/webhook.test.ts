import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'wh-')), 'test.db');

const { verifySignature, mentionFromWebhook, webhookConfigured } = await import(
  '../src/api/routes/webhook.js'
);

const SECRET = 'shhh-test-secret';
const sign = (body: string, secret = SECRET): string =>
  createHmac('sha512', secret).update(body).digest('hex');

beforeEach(() => {
  process.env.NEYNAR_WEBHOOK_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.NEYNAR_WEBHOOK_SECRET;
});

/**
 * The signature is the security boundary for autonomous replies: the
 * entitlement that decides whether the agent answers on its own hangs on the
 * FID inside this request body. A forged body is a remote trigger for the
 * agent's voice.
 */
describe('verifySignature', () => {
  const body = '{"type":"cast.created"}';

  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, sign(body))).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    const sig = sign(body);
    expect(verifySignature('{"type":"cast.created","evil":1}', sig)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifySignature(body, sign(body, 'wrong-secret'))).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(verifySignature(body, undefined)).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    delete process.env.NEYNAR_WEBHOOK_SECRET;
    expect(webhookConfigured()).toBe(false);
    expect(verifySignature(body, sign(body))).toBe(false);
  });
});

describe('mentionFromWebhook', () => {
  // Shape taken from Neynar's published cast.created example.
  const payload = {
    created_at: 1708025006,
    type: 'cast.created',
    data: {
      object: 'cast',
      hash: '0xfe7908021a4c0d36d5f7359975f4bf6eb9fbd6f2',
      text: '@oracle how many pools quote NVDA?',
      timestamp: '2024-02-15T19:23:22.000Z',
      author: { object: 'user', fid: 234506, username: 'balzgolf' },
    },
  };

  it('maps the documented payload to a mention', () => {
    const m = mentionFromWebhook(payload)!;
    expect(m.hash).toBe(payload.data.hash);
    expect(m.author).toBe('balzgolf');
    // The FID is what entitlements hang on, so it must survive as a string.
    expect(m.authorFid).toBe('234506');
    expect(m.text).toContain('NVDA');
  });

  it('ignores event types that are not cast.created', () => {
    expect(mentionFromWebhook({ ...payload, type: 'reaction.created' })).toBeNull();
  });

  it('ignores a cast with no text or no hash', () => {
    expect(mentionFromWebhook({ type: 'cast.created', data: { hash: '0xa' } })).toBeNull();
    expect(mentionFromWebhook({ type: 'cast.created', data: { text: 'hi' } })).toBeNull();
  });

  it('survives an author with no fid rather than inventing one', () => {
    const m = mentionFromWebhook({
      type: 'cast.created',
      data: { hash: '0xa', text: 'hi', author: { username: 'nobody' } },
    })!;
    // null, not "undefined" — the autonomy gate refuses a mention with no FID,
    // and a string would sail past that check.
    expect(m.authorFid).toBeNull();
  });
});
