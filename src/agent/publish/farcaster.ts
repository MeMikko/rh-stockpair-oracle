import type { Publisher, PublishResult } from './index.js';

/** Farcaster via Neynar. Credentials come from the environment, never the repo. */
export const farcaster: Publisher = {
  channel: 'farcaster',

  configured(): boolean {
    return Boolean(process.env.NEYNAR_API_KEY && process.env.NEYNAR_SIGNER_UUID);
  },

  async publish(text: string, dryRun: boolean, replyTo?: string | null): Promise<PublishResult> {
    if (dryRun || !this.configured()) {
      return { channel: 'farcaster', ref: null, dryRun: true };
    }
    const res = await fetch('https://api.neynar.com/v2/farcaster/cast', {
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
        ...(replyTo ? { parent: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      return { channel: 'farcaster', ref: null, dryRun: false,
               error: `neynar ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const body = (await res.json()) as { cast?: { hash?: string } };
    return { channel: 'farcaster', ref: body.cast?.hash ?? null, dryRun: false };
  },
};
