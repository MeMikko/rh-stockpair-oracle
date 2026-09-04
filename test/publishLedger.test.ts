import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * What the agent's record says about what the agent has said.
 *
 * The bug: a post going to two channels carried one status, so a run where
 * Farcaster succeeded and X failed marked the whole post `failed` — while the
 * claim was live on Farcaster. The record was wrong about the agent's own
 * public statements, and a re-run would have posted it there a second time.
 *
 * Every test here is about that pair of properties: the record matches what
 * reached a channel, and nothing reaches a channel twice.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'publish-ledger-')), 'test.db');

const { getDb } = await import('../src/db/index.js');
const {
  claimDelivery, settleDelivery, deliveriesFor, settlePost, enqueue, decide, getPost,
} = await import('../src/agent/queue.js');
const { publishPost, publishers } = await import('../src/agent/publish/index.js');

type Pub = (typeof publishers)['farcaster'];
const original = { farcaster: publishers.farcaster, x: publishers.x };

/** A publisher that does what the test tells it to, and counts its calls. */
function stub(channel: string, behaviour: 'ok' | 'error' | 'throw') {
  const calls = { n: 0 };
  const p = {
    channel,
    configured: () => true,
    publish: async (_t: string, dry: boolean) => {
      calls.n += 1;
      if (behaviour === 'throw') throw new Error('socket hang up');
      return behaviour === 'ok'
        ? { channel, ref: `${channel}-ref`, dryRun: dry }
        : { channel, ref: null, dryRun: dry, error: 'rate limited' };
    },
  } as unknown as Pub;
  return { p, calls };
}

function queueApproved(id: string, channels: string[]) {
  // posts.signal_id references signals(id), so the signal has to exist first.
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO signals (id, kind, severity, summary, facts_json, reproduce, detected_at)
       VALUES (?, 'closed_market_drift', 'notable', 'test', '{}', 'GET /history?symbol=NVDA', 0)`,
    )
    .run(id);
  const post = enqueue(
    id,
    { text: 'NVDA drifts 2.1% while the market is closed.', draftedBy: 'template', verification: { ok: true, unsupported: [] } as never },
    channels,
  )!;
  decide(post.id, 'approved', 'test');
  return getPost(post.id)!;
}

beforeEach(() => {
  getDb().exec('DELETE FROM posts');
  getDb().exec('DELETE FROM signals');
  getDb().exec('DELETE FROM post_deliveries');
  (publishers as Record<string, Pub>).farcaster = original.farcaster;
  (publishers as Record<string, Pub>).x = original.x;
});

describe('claiming a channel', () => {
  it('grants the first claim and refuses the second', () => {
    expect(claimDelivery('p1', 'x')).toBe(true);
    expect(claimDelivery('p1', 'x')).toBe(false);
  });

  /**
   * The rule that costs a little coverage and buys the important guarantee: a
   * send that errored may still have arrived, so the ledger will not try again
   * on its own.
   */
  it('still refuses after the attempt failed', () => {
    claimDelivery('p1', 'x');
    settleDelivery('p1', 'x', 'failed', { error: 'timeout' });
    expect(claimDelivery('p1', 'x')).toBe(false);
  });

  it('keeps channels independent', () => {
    expect(claimDelivery('p1', 'x')).toBe(true);
    expect(claimDelivery('p1', 'farcaster')).toBe(true);
  });
});

describe('a post that reached one channel and not the other', () => {
  it('is posted, not failed — the claim is public', () => {
    claimDelivery('p2', 'farcaster');
    settleDelivery('p2', 'farcaster', 'sent', { ref: 'cast-1' });
    claimDelivery('p2', 'x');
    settleDelivery('p2', 'x', 'failed', { error: 'rate limited' });

    const post = queueApproved('sig-2', ['farcaster', 'x']);
    getDb().prepare('UPDATE post_deliveries SET post_id = ? WHERE post_id = ?').run(post.id, 'p2');

    const settled = settlePost(post.id)!;
    expect(settled.status).toBe('posted');
    // The failure is still on the record rather than traded away for a tidy
    // status: an operator must be able to see that X did not get it.
    expect(settled.error).toMatch(/x: rate limited/);
    expect(settled.postRefs).toBe('farcaster:cast-1');
  });

  it('is failed only when nothing reached anyone', () => {
    const post = queueApproved('sig-3', ['farcaster', 'x']);
    for (const ch of ['farcaster', 'x']) {
      claimDelivery(post.id, ch);
      settleDelivery(post.id, ch, 'failed', { error: 'down' });
    }
    expect(settlePost(post.id)!.status).toBe('failed');
  });
});

describe('publishing end to end', () => {
  /**
   * The ledger as the last line, not the first.
   *
   * Two guards already stood between a post and a second send: `publishPost`
   * refuses anything but `approved`, and `decide` only moves a `draft` there.
   * So a duplicate was never one re-run away — it needed the status put back
   * by hand, which is exactly what someone does when they see a post marked
   * `failed` and want it out. The ledger is what makes that safe, because it
   * remembers the channel rather than the post's status.
   */
  it('refuses a channel already delivered, even if the status is forced back', async () => {
    const far = stub('farcaster', 'ok');
    const xs = stub('x', 'error');
    (publishers as Record<string, Pub>).farcaster = far.p;
    (publishers as Record<string, Pub>).x = xs.p;

    const post = queueApproved('sig-4', ['farcaster', 'x']);
    const first = await publishPost(post, true);
    expect(first.status).toBe('posted');
    expect(far.calls.n).toBe(1);

    // What a person with database access does to "just send it again".
    getDb().prepare("UPDATE posts SET status = 'approved' WHERE id = ?").run(post.id);
    const again = await publishPost(getPost(post.id)!, true);

    expect(far.calls.n).toBe(1);
    expect(xs.calls.n).toBe(1);
    expect(again.results.every((r) => r.alreadyAttempted)).toBe(true);
  });

  /** And the guards that were already there still hold on their own. */
  it('will not publish a post that is not approved', async () => {
    // Stubbed, because an unconfigured channel is skipped and leaves the post
    // approved — which would make this pass for the wrong reason.
    (publishers as Record<string, Pub>).farcaster = stub('farcaster', 'ok').p;
    const post = queueApproved('sig-7', ['farcaster']);
    await publishPost(post, true);
    await expect(publishPost(getPost(post.id)!, true)).rejects.toThrow(/not 'approved'/);
  });

  it('records a thrown publisher as failed rather than leaving it claimed', async () => {
    (publishers as Record<string, Pub>).farcaster = stub('farcaster', 'throw').p;
    const post = queueApproved('sig-5', ['farcaster']);
    const out = await publishPost(post, true);

    expect(out.status).toBe('failed');
    const d = deliveriesFor(post.id)[0]!;
    // Not 'claimed': a row stuck there would block the channel forever and
    // never say why.
    expect(d.status).toBe('failed');
    expect(d.error).toMatch(/socket hang up/);
  });

  /** A dry run must not burn the channel for the real send that follows. */
  it('claims nothing on a dry run', async () => {
    const far = stub('farcaster', 'ok');
    (publishers as Record<string, Pub>).farcaster = far.p;
    const post = queueApproved('sig-6', ['farcaster']);

    const dry = await publishPost(post, false);
    expect(dry.status).toBe('dry-run');
    expect(deliveriesFor(post.id)).toHaveLength(0);

    const live = await publishPost(getPost(post.id)!, true);
    expect(live.status).toBe('posted');
    expect(deliveriesFor(post.id)[0]!.status).toBe('sent');
  });
});
