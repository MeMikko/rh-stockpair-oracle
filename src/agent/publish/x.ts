import type { Publisher, PublishResult } from './index.js';

/**
 * X. Left intentionally unimplemented past the dry run: posting needs OAuth 1.0a
 * request signing, and shipping a half-signed request that silently fails is
 * worse than a channel that plainly says it is not wired up yet.
 */
export const x: Publisher = {
  channel: 'x',

  configured(): boolean {
    return Boolean(
      process.env.X_API_KEY && process.env.X_API_SECRET &&
      process.env.X_ACCESS_TOKEN && process.env.X_ACCESS_SECRET,
    );
  },

  async publish(_text: string, dryRun: boolean): Promise<PublishResult> {
    if (dryRun || !this.configured()) {
      return { channel: 'x', ref: null, dryRun: true };
    }
    return { channel: 'x', ref: null, dryRun: false,
             error: 'x publisher not implemented: OAuth 1.0a signing not wired up' };
  },
};
