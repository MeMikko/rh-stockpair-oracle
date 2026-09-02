import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyMessage, type Address } from 'viem';
import { getDb } from '../db/index.js';
import { normaliseSubject, resolve, type Resolution } from '../entitlements/index.js';

/**
 * Proving who you are, so an entitlement can apply.
 *
 * The entitlements module refuses to honour a merely *claimed* identity, which
 * is what makes this necessary: without proof, every HTTP caller resolves to
 * free no matter what they send. A wallet signature is the proof, and it is
 * self-contained — no third party, no OAuth, nothing to be down.
 *
 * Two properties matter more than convenience here:
 *
 *  - a nonce is single-use, so a captured signature cannot be replayed;
 *  - the session is a signed token rather than a stored row, so there is no
 *    session table to leak, and expiry is arithmetic rather than cleanup.
 */

const NONCE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

export const authConfig = {
  /**
   * Signing key for session tokens. No default: a hardcoded fallback would
   * mean every deployment that forgot to set one shares a key with which
   * anyone can mint a session for any address.
   */
  secret: process.env.AUTH_SECRET?.trim() ?? '',
  /** Shown in the message the user signs, so they can see what they sign for. */
  domain: process.env.AUTH_DOMAIN?.trim() || 'oracle.sb4s.xyz',
};

export function authConfigured(): boolean {
  return authConfig.secret.length >= 16;
}

/** The exact text the wallet is asked to sign. */
export function signInMessage(address: string, nonce: string): string {
  return [
    `${authConfig.domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    'Signing proves you control this address. It authorises nothing else:',
    'no transaction, no approval, no transfer.',
    '',
    `Nonce: ${nonce}`,
  ].join('\n');
}

export function issueNonce(): string {
  const nonce = randomBytes(16).toString('hex');
  getDb()
    .prepare('INSERT INTO auth_nonces (nonce, issued_at, used) VALUES (?, ?, 0)')
    .run(nonce, Date.now());
  return nonce;
}

/**
 * Spend a nonce. Returns false if it was never issued, already spent, or has
 * expired — all three of which mean the signature must not be accepted.
 */
export function consumeNonce(nonce: string): boolean {
  const db = getDb();
  const row = db
    .prepare('SELECT issued_at, used FROM auth_nonces WHERE nonce = ?')
    .get(nonce) as { issued_at: number; used: number } | undefined;
  if (!row || row.used === 1) return false;
  if (Date.now() - Number(row.issued_at) > NONCE_TTL_MS) return false;
  db.prepare('UPDATE auth_nonces SET used = 1 WHERE nonce = ?').run(nonce);
  // Opportunistic cleanup: this table is write-heavy and read-once, and
  // nothing else would ever prune it.
  db.prepare('DELETE FROM auth_nonces WHERE issued_at < ?').run(Date.now() - 2 * NONCE_TTL_MS);
  return true;
}

const b64u = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s: string): string =>
  Buffer.from(s, 'base64url').toString('utf8');

function sign(payload: string): string {
  return createHmac('sha256', authConfig.secret).update(payload).digest('base64url');
}

export interface Session {
  subjectType: 'address';
  subject: string;
  expiresAt: number;
}

export function mintSession(address: string): string {
  const body = JSON.stringify({
    t: 'address',
    s: normaliseSubject('address', address),
    e: Date.now() + SESSION_TTL_MS,
  });
  const p = b64u(body);
  return `${p}.${sign(p)}`;
}

export function readSession(token: string | undefined): Session | null {
  if (!token || !authConfigured()) return null;
  const [p, mac] = token.split('.');
  if (!p || !mac) return null;

  const expected = Buffer.from(sign(p), 'utf8');
  const given = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const body = JSON.parse(unb64u(p)) as { t?: string; s?: string; e?: number };
    if (body.t !== 'address' || !body.s || !body.e) return null;
    if (body.e <= Date.now()) return null;
    return { subjectType: 'address', subject: body.s, expiresAt: body.e };
  } catch {
    return null;
  }
}

/**
 * Check a signature against the message we asked for, then spend the nonce.
 *
 * The nonce is consumed only after the signature checks out, so a bad
 * signature cannot burn a valid nonce and lock someone out of retrying.
 */
export async function verifySignIn(opts: {
  address: string;
  signature: string;
  nonce: string;
}): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  if (!authConfigured()) return { ok: false, error: 'sign-in is not configured on this server' };

  let address: string;
  try {
    address = normaliseSubject('address', opts.address);
  } catch {
    return { ok: false, error: 'malformed address' };
  }

  const db = getDb();
  const row = db
    .prepare('SELECT issued_at, used FROM auth_nonces WHERE nonce = ?')
    .get(opts.nonce) as { issued_at: number; used: number } | undefined;
  if (!row) return { ok: false, error: 'unknown nonce' };
  if (row.used === 1) return { ok: false, error: 'nonce already used' };
  if (Date.now() - Number(row.issued_at) > NONCE_TTL_MS) return { ok: false, error: 'nonce expired' };

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as Address,
      message: signInMessage(address, opts.nonce),
      signature: opts.signature as `0x${string}`,
    });
  } catch {
    return { ok: false, error: 'signature could not be checked' };
  }
  if (!valid) return { ok: false, error: 'signature does not match that address' };

  consumeNonce(opts.nonce);
  return { ok: true, token: mintSession(address) };
}

/**
 * Tier for a request, from its session.
 *
 * A session is proof, so this is the one HTTP path allowed to assert
 * `verified`. Everything without a session stays free regardless of what it
 * claims to be.
 */
export function tierForSession(token: string | undefined): Resolution {
  const s = readSession(token);
  if (!s) {
    return {
      tier: 'free',
      assertion: 'claimed',
      subjectType: null,
      subject: null,
      reason: 'not signed in',
    };
  }
  return resolve('address', s.subject, 'verified');
}
