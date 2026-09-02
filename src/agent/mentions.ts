import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { answerQuestion } from '../answer/answer.js';
import { saveSignals, type Signal } from './signals.js';

/**
 * Farcaster mentions -> queued replies.
 *
 * The agent answers questions, but it does not answer them autonomously: a
 * reply is a public claim by the same account that publishes the feed, so it
 * goes through the same approval queue as a broadcast. Nothing here can reach
 * a timeline on its own.
 *
 * The answer itself is deterministic (see answer/answer.ts) -- a model is
 * never asked what is true, only, elsewhere, how to phrase something already
 * established. So the human reviewing the queue is checking tone and
 * relevance, not fact-checking arithmetic.
 */

export interface Mention {
  hash: string;
  author: string;
  text: string;
  timestamp: number;
}

export function neynarConfigured(): boolean {
  return Boolean(process.env.NEYNAR_API_KEY);
}

/**
 * Recent mentions of the agent's FID.
 *
 * Reads only; posting a reply is a separate, approval-gated step. The cursor
 * is deliberately not stored on the Neynar side -- dedupe is local, keyed on
 * cast hash, so a restart or a re-run cannot double-answer.
 */
export async function fetchMentions(fid: string, limit = 25): Promise<Mention[]> {
  if (!neynarConfigured()) throw new Error('NEYNAR_API_KEY is not set');

  const url = new URL('https://api.neynar.com/v2/farcaster/notifications');
  url.searchParams.set('fid', fid);
  url.searchParams.set('type', 'mentions');
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url, {
    headers: { 'x-api-key': process.env.NEYNAR_API_KEY!, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`neynar ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as {
    notifications?: Array<{
      cast?: { hash?: string; text?: string; timestamp?: string; author?: { username?: string } };
    }>;
  };

  return (body.notifications ?? [])
    .map((n) => n.cast)
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.hash && c.text))
    .map((c) => ({
      hash: c.hash!,
      author: c.author?.username ?? 'unknown',
      text: c.text!,
      timestamp: c.timestamp ? Date.parse(c.timestamp) : Date.now(),
    }));
}

/** Mentions not already turned into a queued reply. */
export function unanswered(mentions: Mention[]): Mention[] {
  const db = getDb();
  const seen = db.prepare('SELECT 1 FROM posts WHERE reply_to = ? LIMIT 1');
  return mentions.filter((m) => !seen.get(m.hash));
}

/**
 * Turn one mention into a signal.
 *
 * An answer is stored as a signal like any other observation, which is what
 * lets a reply reuse the whole pipeline unchanged -- verification, the queue,
 * approval, publishing. The id is keyed on the cast hash so one mention can
 * only ever produce one reply.
 */
export async function signalForMention(m: Mention): Promise<{ signal: Signal; answered: boolean }> {
  const a = await answerQuestion(m.text);
  const id = createHash('sha256').update(`mention:${m.hash}`).digest('hex').slice(0, 16);

  return {
    answered: a.answered,
    signal: {
      id,
      kind: 'mention_answer',
      severity: 'info',
      summary: `reply to @${m.author}: ${a.intent.kind}`,
      // The answer's own facts, plus the provenance of the question. The
      // verifier runs against this, so a reply can cite nothing the answer
      // did not establish.
      facts: {
        ...a.facts,
        askedBy: m.author,
        castHash: m.hash,
        intent: a.intent.kind,
      },
      reproduce: a.reproduce,
      detectedAt: Date.now(),
    },
  };
}

export function saveMentionSignal(signal: Signal): void {
  saveSignals([signal]);
}
