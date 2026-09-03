import { markFailed, markPosted, type QueuedPost } from '../queue.js';
import { farcaster } from './farcaster.js';
import { x } from './x.js';

export interface PublishResult {
  channel: string;
  ref: string | null;
  dryRun: boolean;
  error?: string;
}

export interface Publisher {
  channel: string;
  configured(): boolean;
  publish(text: string, dryRun: boolean, replyTo?: string | null): Promise<PublishResult>;
}

/**
 * Publishing is gated three ways, all of which must hold:
 *   1. the post is `approved` -- a person acted on it;
 *   2. credentials for the channel exist in the environment;
 *   3. the caller passed --live explicitly.
 *
 * Anything less is a dry run that prints what would be sent. The default is a
 * dry run, so an accidental invocation cannot reach a public timeline.
 */
export function assertPublishable(post: QueuedPost): void {
  if (post.status !== 'approved') {
    throw new Error(
      `refusing to publish post ${post.id}: status is '${post.status}', not 'approved'. ` +
      `Every post requires explicit human approval.`,
    );
  }
}

export const publishers = { farcaster, x } as const;

export interface PublishOutcome {
  postId: string;
  live: boolean;
  /** Channels with no credentials. The post stays approved rather than failing. */
  skipped: string[];
  results: PublishResult[];
  status: 'posted' | 'failed' | 'skipped' | 'dry-run';
}

/**
 * Send one approved post, or say what sending it would do.
 *
 * Lifted out of the CLI so the operator panel and `agent:publish` cannot
 * drift: the rules about what may go out — approved only, credentials
 * present, `live` asked for explicitly — are worth exactly nothing if there
 * are two copies of them and only one gets fixed.
 *
 * A dry run touches no channel and changes no row. A live run marks the post
 * posted or failed, and never leaves it silently in between.
 */
export async function publishPost(post: QueuedPost, live: boolean): Promise<PublishOutcome> {
  assertPublishable(post);

  // An unconfigured channel is not a failed post. Skipping leaves it approved
  // so it can go out once credentials exist, rather than burning a post a
  // person already signed off on.
  const skipped = live
    ? post.channels.filter((ch) => {
        const p = publishers[ch as keyof typeof publishers];
        return !p || !p.configured();
      })
    : [];
  if (live && skipped.length > 0) {
    return { postId: post.id, live, skipped, results: [], status: 'skipped' };
  }

  const results: PublishResult[] = [];
  for (const ch of post.channels) {
    const pub = publishers[ch as keyof typeof publishers];
    if (!pub) {
      results.push({ channel: ch, ref: null, dryRun: true, error: 'unknown channel' });
      continue;
    }
    results.push(await pub.publish(post.draftText, !live, post.replyTo));
  }

  if (!live) return { postId: post.id, live, skipped, results, status: 'dry-run' };

  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    markFailed(post.id, errors.map((e) => `${e.channel}: ${e.error}`).join('; '));
    return { postId: post.id, live, skipped, results, status: 'failed' };
  }
  markPosted(post.id, results.map((r) => `${r.channel}:${r.ref}`).join(','));
  return { postId: post.id, live, skipped, results, status: 'posted' };
}
