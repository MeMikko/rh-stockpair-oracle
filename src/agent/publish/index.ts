import type { QueuedPost } from '../queue.js';

export interface PublishResult {
  channel: string;
  ref: string | null;
  dryRun: boolean;
  error?: string;
}

export interface Publisher {
  channel: string;
  configured(): boolean;
  publish(text: string, dryRun: boolean): Promise<PublishResult>;
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
