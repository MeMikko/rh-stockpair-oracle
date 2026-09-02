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
      // Trailing slash as published in the OpenAPI spec. A POST that gets
      // redirected can lose its body in some clients, so the documented path
      // is used verbatim rather than the one that merely usually works.
      res = await fetch('https://api.neynar.com/v2/farcaster/cast/', {
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
      // Neynar returns a structured ErrorRes ({message, code, property}).
      // Surfacing `message` rather than a truncated blob is the difference
      // between "signer not approved" and a wall of JSON at 3am.
      const raw = await res.text();
      let detail = raw.slice(0, 200);
      try {
        const e = JSON.parse(raw) as { message?: string; code?: string };
        if (e.message) detail = e.code ? `${e.message} (${e.code})` : e.message;
      } catch {
        /* not JSON; the raw body is the best we have */
      }
      return {
        channel: 'farcaster',
        ref: null,
        dryRun: false,
        error: `neynar ${res.status}: ${detail}`,
      };
    }

    // PostCastResponse is { success, cast: { hash, author: { fid }, text } }.
    // A 200 without a hash would mean the cast was not actually created, so
    // it is treated as a failure rather than recorded as a send.
    const body = (await res.json()) as { success?: boolean; cast?: { hash?: string } };
    if (!body.cast?.hash) {
      return {
        channel: 'farcaster',
        ref: null,
        dryRun: false,
        error: 'neynar returned 200 without a cast hash',
      };
    }
    return { channel: 'farcaster', ref: body.cast.hash, dryRun: false };
  },
};
