import { createHash } from 'node:crypto';
import type { Publisher, PublishResult } from './index.js';

/**
 * Farcaster via Neynar. Credentials come from the environment, never the repo.
 *
 * Spoken directly over fetch rather than through @neynar/nodejs-sdk: this is
 * one POST, and a dependency that wraps one POST is a dependency to keep
 * updated for no reduction in code.
 */

/**
 * Idempotency key for a cast, derived from what makes it unique rather than
 * from the moment it is sent.
 *
 * The autonomous reply path records a send only after Neynar confirms it. A
 * crash in that gap would otherwise mean the next pass replies to the same
 * mention a second time -- publicly, and with no way to take it back. Keying
 * on the parent cast makes the retry a no-op at Neynar's end instead.
 *
 * A broadcast has no parent, so it is keyed on its own text: two different
 * posts are two casts, and the same post sent twice is one.
 */
function idempotencyKey(text: string, replyTo?: string | null): string {
  return createHash('sha256')
    .update(replyTo ? `reply:${replyTo}` : `post:${text}`)
    .digest('hex')
    .slice(0, 16);
}

export const farcaster: Publisher = {
  channel: 'farcaster',

  configured(): boolean {
    return Boolean(process.env.NEYNAR_API_KEY && process.env.NEYNAR_SIGNER_UUID);
  },

  async publish(text: string, dryRun: boolean, replyTo?: string | null): Promise<PublishResult> {
    if (dryRun || !this.configured()) {
      return { channel: 'farcaster', ref: null, dryRun: true };
    }

    let res: Response;
    try {
      res = await fetch('https://api.neynar.com/v2/farcaster/cast', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.NEYNAR_API_KEY!,
        },
        // `parent` turns the cast into a reply to that hash. Omitted entirely
        // for a broadcast -- sending it as null makes Neynar reject the cast.
        body: JSON.stringify({
          signer_uuid: process.env.NEYNAR_SIGNER_UUID,
          text,
          idem: idempotencyKey(text, replyTo),
          ...(replyTo ? { parent: replyTo } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // A timeout is the dangerous case: the cast may well have been created.
      // Reported as an error so the caller does not record it as sent, and
      // the idempotency key makes the inevitable retry safe.
      return {
        channel: 'farcaster',
        ref: null,
        dryRun: false,
        error: `neynar unreachable: ${(err as Error).message.slice(0, 160)}`,
      };
    }

    if (!res.ok) {
      return {
        channel: 'farcaster',
        ref: null,
        dryRun: false,
        error: `neynar ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }

    const body = (await res.json()) as { cast?: { hash?: string } };
    return { channel: 'farcaster', ref: body.cast?.hash ?? null, dryRun: false };
  },
};
