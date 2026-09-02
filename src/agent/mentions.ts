import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { answerQuestion } from '../answer/answer.js';
import { tierForFid } from '../entitlements/index.js';
import { agentIdentity } from '../../config/agent.js';
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
  /**
   * The author's FID as reported by Neynar. This is the field entitlements
   * hang on, and it is trustworthy precisely because Neynar asserted it rather
   * than the caller -- unlike anything arriving in an HTTP request.
   */
  authorFid: string | null;
  text: string;
  timestamp: number;
}

export function neynarConfigured(): boolean {
  return Boolean(process.env.NEYNAR_API_KEY);
}

/**
 * Recent mentions of the agent's FID.
 *
 * Reads only; sending a reply is a separate step. The cursor is deliberately
 * not stored on the Neynar side -- dedupe is local, keyed on cast hash, so a
 * restart or a re-run cannot double-answer.
 *
 * UNVERIFIED against the published spec, unlike the cast endpoint: the
 * response shape below (`notifications[].cast`) was written from the API's
 * general shape, not from Neynar's OpenAPI document. A field name that is
 * wrong here fails closed -- the filter drops casts missing a hash or text, so
 * the agent finds no mentions rather than mishandling one -- but the first
 * live run should be checked against real output before autonomy is enabled.
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
      cast?: {
      hash?: string;
      text?: string;
      timestamp?: string;
      author?: { username?: string; fid?: number | string };
    };
    }>;
  };

  return (body.notifications ?? [])
    .map((n) => n.cast)
    .filter((c): c is NonNullable<typeof c> => Boolean(c?.hash && c.text))
    .map((c) => ({
      hash: c.hash!,
      author: c.author?.username ?? 'unknown',
      authorFid: c.author?.fid === undefined ? null : String(c.author.fid),
      text: c.text!,
      timestamp: c.timestamp ? Date.parse(c.timestamp) : Date.now(),
    }));
}

/**
 * The part of a cast that is actually the question.
 *
 * A mention arrives as the whole post, and the question addressed to the agent
 * is normally whatever follows the handle. Classifying the entire cast reads
 * the author's own prose as a query: an announcement mentioning "an oracle"
 * and linking oracle.sb4s.xyz was answered with feed-coverage statistics,
 * because the coverage rule matches the word `oracle` and our own domain
 * contains it. That would have happened on every cast that shared the link.
 *
 * So take what follows the handle when there is anything there, and strip
 * URLs either way. A link is never the question, and ours in particular
 * carries a keyword that would otherwise match wherever it appeared.
 */
export function questionFromCast(text: string, handle = agentIdentity.farcasterHandle): string {
  const withoutUrls = text
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\b[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\b(?:\/\S*)?/gi, ' ');

  const at = new RegExp(`@${handle}\\b`, 'i');
  const m = withoutUrls.match(at);
  if (m && m.index !== undefined) {
    const after = withoutUrls.slice(m.index + m[0].length).trim();
    if (after.length > 0) return after;
  }

  // Mention at the very end, or none found: fall back to the whole cast with
  // handles removed, which is still better than leaving a link in it.
  return withoutUrls.replace(/@[a-z0-9_.-]+/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Mentions not already dealt with — queued for approval *or* answered
 * autonomously. Both paths have to be consulted, or a restart would answer
 * the same cast twice by two different routes.
 */
export function unanswered(mentions: Mention[]): Mention[] {
  const db = getDb();
  const queued = db.prepare('SELECT 1 FROM posts WHERE reply_to = ? LIMIT 1');
  const auto = db.prepare('SELECT 1 FROM auto_replies WHERE cast_hash = ? LIMIT 1');
  return mentions.filter((m) => !queued.get(m.hash) && !auto.get(m.hash));
}

/**
 * Turn one mention into a signal.
 *
 * An answer is stored as a signal like any other observation, which is what
 * lets a reply reuse the whole pipeline unchanged -- verification, the queue,
 * approval, publishing. The id is keyed on the cast hash so one mention can
 * only ever produce one reply.
 */
export async function signalForMention(
  m: Mention,
): Promise<{ signal: Signal; answered: boolean; conversational: boolean }> {
  // The asker's tier decides whether the model may answer an open-ended
  // question. Without passing it, a pro subscriber tagging the agent got the
  // canned refusal that a stranger gets.
  const tier = m.authorFid ? tierForFid(m.authorFid).tier : 'free';
  const a = await answerQuestion(questionFromCast(m.text), new Date(), { tier });
  const id = createHash('sha256').update(`mention:${m.hash}`).digest('hex').slice(0, 16);

  return {
    answered: a.answered,
    conversational: Boolean(a.conversational),
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
        askedByFid: m.authorFid,
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
