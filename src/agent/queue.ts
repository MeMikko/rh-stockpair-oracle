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
