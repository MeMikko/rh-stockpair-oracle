import { describe, it, expect, beforeEach } from 'vitest';

process.env.DB_PATH = './data/test-queue.db';
const { enqueue, decide, listPosts, getPost, markPosted, markFailed } = await import('../src/agent/queue.js');
const { getDb } = await import('../src/db/index.js');
const { verifyDraft } = await import('../src/agent/verify.js');

const draft = (text = 'a post with 3 pools') => ({
  text, draftedBy: 'template', verification: verifyDraft(text, { affectedPools: 3 }),
});

describe('approval queue', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM posts');
    getDb().exec("DELETE FROM signals");
    getDb().prepare(
      `INSERT INTO signals (id, kind, severity, summary, facts_json, reproduce, detected_at)
       VALUES ('sig1','test','notable','s','{}','GET /x',1)`).run();
    getDb().prepare(
      `INSERT INTO signals (id, kind, severity, summary, facts_json, reproduce, detected_at)
       VALUES ('sig2','test','notable','s','{}','GET /x',1)`).run();
  });

  it('queues a draft in draft status, never approved', () => {
    const p = enqueue('sig1', draft(), ['farcaster'])!;
    expect(p.status).toBe('draft');
    expect(p.channels).toEqual(['farcaster']);
  });

  it('will not queue two posts for the same signal', () => {
    expect(enqueue('sig1', draft(), ['farcaster'])).not.toBeNull();
    expect(enqueue('sig1', draft('different text'), ['farcaster'])).toBeNull();
    expect(listPosts()).toHaveLength(1);
  });

  it('records who approved a post', () => {
    const p = enqueue('sig1', draft(), ['farcaster'])!;
    const d = decide(p.id, 'approved', 'mikko');
    expect(d.status).toBe('approved');
    expect(d.decidedBy).toBe('mikko');
    expect(d.decidedAt).toBeGreaterThan(0);
  });

  it('refuses to re-decide anything that is not a draft', () => {
    const p = enqueue('sig1', draft(), ['farcaster'])!;
    decide(p.id, 'rejected', 'mikko');
    expect(() => decide(p.id, 'approved', 'mikko')).toThrow(/only a draft/);
  });

  it('refuses to decide an unknown post', () => {
    expect(() => decide('nope', 'approved', 'mikko')).toThrow(/no such post/);
  });

  it('keeps rejected posts out of the approved list', () => {
    const a = enqueue('sig1', draft(), ['farcaster'])!;
    const b = enqueue('sig2', draft(), ['farcaster'])!;
    decide(a.id, 'approved', 'm');
    decide(b.id, 'rejected', 'm');
    expect(listPosts('approved').map(p => p.id)).toEqual([a.id]);
  });

  it('records refs on success and error on failure', () => {
    const a = enqueue('sig1', draft(), ['farcaster'])!;
    decide(a.id, 'approved', 'm');
    markPosted(a.id, 'farcaster:0xabc');
    expect(getPost(a.id)!.status).toBe('posted');
    expect(getPost(a.id)!.postRefs).toBe('farcaster:0xabc');

    const b = enqueue('sig2', draft(), ['farcaster'])!;
    decide(b.id, 'approved', 'm');
    markFailed(b.id, 'neynar 401');
    expect(getPost(b.id)!.status).toBe('failed');
    expect(getPost(b.id)!.error).toContain('401');
  });
});
