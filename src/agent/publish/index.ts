import { claimDelivery, settleDelivery, settlePost, type QueuedPost } from '../queue.js';
import { farcaster } from './farcaster.js';
import { x } from './x.js';

export interface PublishResult {
  channel: string;
  ref: string | null;
  dryRun: boolean;
  error?: string;
  /**
   * Set when the channel was not attempted because a delivery row already
   * existed. Not an error: it is the ledger refusing to send the same post
   * twice, which is the whole reason the ledger exists.
   */
  alreadyAttempted?: boolean;
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
    if (!live) {
      // A dry run claims nothing. Writing a ledger row here would burn the
      // channel for the real send that follows.
      results.push(await pub.publish(post.draftText, true, post.replyTo));
      continue;
    }

    // Claim first. Concurrent runs collapse to one attempt, and a channel that
    // has been tried before -- including one that errored -- is not tried
    // again: the error may have been a timeout on a send that arrived.
    if (!claimDelivery(post.id, ch)) {
      results.push({
        channel: ch, ref: null, dryRun: false, alreadyAttempted: true,
        error: 'already attempted; delete its post_deliveries row to send again',
      });
      continue;
    }

    let result: PublishResult;
    try {
      result = await pub.publish(post.draftText, false, post.replyTo);
    } catch (err) {
      // A throw is settled like any other failure rather than left claimed.
      // A row stuck in `claimed` would block the channel forever without ever
      // saying why.
      result = { channel: ch, ref: null, dryRun: false, error: (err as Error).message };
    }
    settleDelivery(
      post.id, ch,
      result.error ? 'failed' : 'sent',
      { ref: result.ref, error: result.error ?? null },
    );
    results.push(result);
  }

  if (!live) return { postId: post.id, live, skipped, results, status: 'dry-run' };

  // The post's status now comes from the ledger rather than from this run, so
  // a channel delivered by an earlier run still counts as delivered.
  const post2 = settlePost(post.id);
  return {
    postId: post.id, live, skipped, results,
    status: post2?.status === 'posted' ? 'posted' : 'failed',
  };
}
