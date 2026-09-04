import { adminConfig } from './auth.js';

/**
 * Whether the panel is reachable only from this machine, or from the internet.
 *
 * This is not a cosmetic flag. Three of the panel's own security decisions
 * were written down as safe *because* it was unreachable — the sign-in error
 * naming whether an address is an allowlisted owner, the cookie left without
 * `Secure`, and the absence of any rate limit on the routes that must stay
 * open to sign in. Publishing it makes each of those wrong, so the mode is
 * read in one place and every one of them consults it.
 *
 * Loopback stays the default. Exposure is something an operator turns on
 * deliberately, never something a `git pull` does.
 */

export type Exposure = 'loopback' | 'remote';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export const adminExposureConfig = {
  host: process.env.ADMIN_HOST?.trim() || '127.0.0.1',
  allowRemote: process.env.ADMIN_ALLOW_REMOTE === '1',
  /**
   * Sessions are shorter when the panel faces the internet: the window in
   * which a stolen cookie is worth anything should be an evening, not a day.
   */
  sessionHours: Number(process.env.ADMIN_SESSION_HOURS ?? 0),
};

export function adminExposure(): Exposure {
  return LOOPBACK.has(adminExposureConfig.host) ? 'loopback' : 'remote';
}

export function sessionTtlMs(): number {
  const configured = adminExposureConfig.sessionHours;
  if (Number.isFinite(configured) && configured > 0) return configured * 3_600_000;
  return (adminExposure() === 'remote' ? 2 : 12) * 3_600_000;
}

/**
 * The extra conditions for facing the internet.
 *
 * Stricter than `adminConfigured()` rather than a copy of it, and checked at
 * boot so a misconfiguration is a process that refuses to start instead of a
 * panel that quietly serves the wallet to anyone who finds the hostname.
 */
export function remoteReadiness(): { ok: true } | { ok: false; error: string } {
  if (adminExposure() === 'loopback') return { ok: true };

  if (!adminExposureConfig.allowRemote) {
    return {
      ok: false,
      error:
        `refusing to bind the operator panel to ${adminExposureConfig.host}. Set ` +
        'ADMIN_ALLOW_REMOTE=1 only once something — a reverse proxy with TLS, a firewall — ' +
        'is in front of it.',
    };
  }
  // 16 is enough for a secret nobody can reach. A secret anyone can attack
  // offline, guarding a panel that reaches a wallet, is not the same problem.
  if (adminConfig.secret.length < 32) {
    return {
      ok: false,
      error:
        'ADMIN_AUTH_SECRET must be at least 32 characters when the panel is exposed. ' +
        '`npm run secrets` generates one.',
    };
  }
  if (process.env.ADMIN_SECURE_COOKIE === '0') {
    return {
      ok: false,
      error:
        'ADMIN_SECURE_COOKIE=0 with an exposed panel would send the session cookie over ' +
        'plain HTTP. Remove it: Secure is forced on when the panel is not on loopback.',
    };
  }
  return { ok: true };
}

/** Secure is not a preference once the cookie crosses a network. */
export function secureCookie(): boolean {
  if (adminExposure() === 'remote') return true;
  return process.env.ADMIN_SECURE_COOKIE === '1';
}

/**
 * What a failed sign-in is allowed to say.
 *
 * On loopback the specific reason saves an operator ten minutes when they
 * mistype their own address. Published, the same sentence answers "is this
 * address one of the owners?" for anyone who asks, which is a list worth
 * having before attacking anything else. The detail still reaches the server
 * log, where only the operator reads it.
 */
export function signInError(reason: string): string {
  return adminExposure() === 'remote' ? 'sign-in failed' : reason;
}
