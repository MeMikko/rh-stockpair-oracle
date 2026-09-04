import { randomUUID } from 'node:crypto';
import { getDb } from '../db/index.js';
import type { Draft } from './draft.js';

export type PostStatus = 'draft' | 'approved' | 'rejected' | 'posted' | 'failed';

export interface QueuedPost {
  id: string;
  signalId: string;
  status: PostStatus;
  channels: string[];
  draftText: string;
  draftedBy: string;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  postedAt: number | null;
  postRefs: string | null;
  error: string | null;
  /** Platform id of the message this answers, when it is a reply. */
  replyTo: string | null;
}

const row2post = (r: Record<string, unknown>): QueuedPost => ({
  id: String(r.id), signalId: String(r.signal_id), status: String(r.status) as PostStatus,
  channels: String(r.channels).split(',').filter(Boolean), draftText: String(r.draft_text),
  draftedBy: String(r.drafted_by), createdAt: Number(r.created_at),
  decidedAt: r.decided_at ? Number(r.decided_at) : null,
  decidedBy: r.decided_by ? String(r.decided_by) : null,
  postedAt: r.posted_at ? Number(r.posted_at) : null,
  postRefs: r.post_refs ? String(r.post_refs) : null,
  error: r.error ? String(r.error) : null,
  replyTo: r.reply_to ? String(r.reply_to) : null,
});

export type DeliveryStatus = 'claimed' | 'sent' | 'failed';

export interface Delivery {
  channel: string;
  status: DeliveryStatus;
  ref: string | null;
  error: string | null;
  claimedAt: number;
  settledAt: number | null;
}

/**
 * Take the right to attempt one channel, or refuse.
 *
 * Returns false when a row already exists in ANY state, including `failed`.
 * That is the point rather than an oversight: a send that errored may still
 * have been delivered — a timeout says nothing about what the far side did —
 * and a duplicate post is worse than a missing one. Re-sending is an operator
 * decision made by deleting the row, not something a re-run does by itself.
 */
export function claimDelivery(postId: string, channel: string): boolean {
  const r = getDb()
    .prepare(
      `INSERT OR IGNORE INTO post_deliveries (post_id, channel, status, claimed_at)
       VALUES (?, ?, 'claimed', ?)`,
    )
    .run(postId, channel, Date.now());
  return Number(r.changes) > 0;
}

export function settleDelivery(
  postId: string,
  channel: string,
  status: 'sent' | 'failed',
  detail: { ref?: string | null; error?: string | null },
): void {
  getDb()
    .prepare(
      `UPDATE post_deliveries SET status = ?, ref = ?, error = ?, settled_at = ?
       WHERE post_id = ? AND channel = ?`,
    )
    .run(status, detail.ref ?? null, detail.error?.slice(0, 500) ?? null, Date.now(), postId, channel);
}

export function deliveriesFor(postId: string): Delivery[] {
  return (
    getDb()
      .prepare('SELECT * FROM post_deliveries WHERE post_id = ? ORDER BY channel')
      .all(postId) as Array<Record<string, unknown>>
  ).map((r) => ({
    channel: String(r.channel),
    status: String(r.status) as DeliveryStatus,
    ref: r.ref ? String(r.ref) : null,
    error: r.error ? String(r.error) : null,
    claimedAt: Number(r.claimed_at),
    settledAt: r.settled_at ? Number(r.settled_at) : null,
  }));
}

/** Queue a draft. One post per signal: re-scanning never duplicates. */
export function enqueue(
  signalId: string,
  draft: Draft,
  channels: string[],
  replyTo?: string,
): QueuedPost | null {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM posts WHERE signal_id = ?').get(signalId) as
    Record<string, unknown> | undefined;
  if (existing) return null;

  const id = randomUUID().slice(0, 8);
  db.prepare(
    `INSERT INTO posts (id, signal_id, status, channels, draft_text, drafted_by, created_at, reply_to)
     VALUES (?, ?, 'draft', ?, ?, ?, ?, ?)`,
  ).run(id, signalId, channels.join(','), draft.text, draft.draftedBy, Date.now(), replyTo ?? null);

  return row2post(db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as Record<string, unknown>);
}

export function listPosts(status?: PostStatus): QueuedPost[] {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM posts WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all();
  return (rows as Record<string, unknown>[]).map(row2post);
}

export function getPost(id: string): QueuedPost | null {
  const r = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return r ? row2post(r) : null;
}

/**
 * Approval is recorded with who did it. Only a `draft` can be approved -- an
 * already-posted or rejected item cannot be revived by a second call.
 */
export function decide(id: string, decision: 'approved' | 'rejected', by: string): QueuedPost {
  const post = getPost(id);
  if (!post) throw new Error(`no such post: ${id}`);
  if (post.status !== 'draft') {
    throw new Error(`post ${id} is '${post.status}', only a draft can be ${decision}`);
  }
  getDb().prepare('UPDATE posts SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?')
    .run(decision, Date.now(), by, id);
  return getPost(id)!;
}

export function markPosted(id: string, refs: string): void {
  getDb().prepare("UPDATE posts SET status = 'posted', posted_at = ?, post_refs = ? WHERE id = ?")
    .run(Date.now(), refs, id);
}

export function markFailed(id: string, error: string): void {
  getDb().prepare("UPDATE posts SET status = 'failed', error = ? WHERE id = ?").run(error.slice(0, 500), id);
}

/**
 * Set the post's status from what actually reached a channel.
 *
 * `posted` the moment ONE channel carried it, because at that point the claim
 * is public and calling the post failed would be a false record of what the
 * agent has said. Any channel that failed is still recorded — in `error` on a
 * posted row, and per channel in post_deliveries — so an operator sees the
 * gap without the post lying about the part that worked.
 */
export function settlePost(id: string): QueuedPost | null {
  const deliveries = deliveriesFor(id);
  const sent = deliveries.filter((d) => d.status === 'sent');
  const failed = deliveries.filter((d) => d.status === 'failed');
  if (sent.length === 0 && failed.length === 0) return getPost(id);

  const errors = failed.map((d) => `${d.channel}: ${d.error ?? 'failed'}`).join('; ');
  if (sent.length > 0) {
    getDb()
      .prepare("UPDATE posts SET status = 'posted', posted_at = ?, post_refs = ?, error = ? WHERE id = ?")
      .run(
        Date.now(),
        sent.map((d) => `${d.channel}:${d.ref}`).join(','),
        errors || null,
        id,
      );
  } else {
    markFailed(id, errors);
  }
  return getPost(id);
}
