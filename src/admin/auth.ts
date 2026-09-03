import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyMessage, type Address } from 'viem';
import { consumeNonce, issueNonce } from '../auth/session.js';
import { getDb } from '../db/index.js';
import { normaliseSubject } from '../entitlements/index.js';

/**
 * Proving you are the operator, not merely a signed-in visitor.
 *
 * The public site already has wallet sign-in, and reusing it here would be the
 * obvious move — and wrong. Its session says "this address controls itself",
 * which is exactly what a stranger's session also says. Admin needs a second,
 * unrelated thing to be true: that the address is on a list the operator
 * wrote.
 *
 * Two details keep the two systems from bleeding into each other:
 *
 *  - a **different signing secret**, so a token minted by the public server is
 *    not a valid admin token even for an allowlisted address;
 *  - a **different signed message**, so a signature captured from the public
 *    sign-in cannot be replayed here. The message says plainly what it
 *    authorises, because it authorises access to a wallet holding funds.
 *
 * The allowlist is required. An empty one means the process refuses to start
 * rather than defaulting to "anyone who signs in".
 */

const SESSION_TTL_MS = 12 * 60 * 60_000;
const NONCE_TTL_MS = 10 * 60_000;

const csv = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const adminConfig = {
  secret: process.env.ADMIN_AUTH_SECRET?.trim() ?? '',
  domain: process.env.ADMIN_DOMAIN?.trim() || 'oracle-admin.local',
  owners: csv(process.env.ADMIN_ADDRESSES),
};

export function adminConfigured(): { ok: true } | { ok: false; error: string } {
  if (adminConfig.secret.length < 16) {
    return { ok: false, error: 'ADMIN_AUTH_SECRET is missing or shorter than 16 characters' };
  }
  if (adminConfig.owners.length === 0) {
    return { ok: false, error: 'ADMIN_ADDRESSES is empty; nobody would be able to sign in, and nothing should be open' };
  }
  const bad = adminConfig.owners.filter((a) => !/^0x[0-9a-f]{40}$/.test(a));
  if (bad.length > 0) {
    return { ok: false, error: `ADMIN_ADDRESSES contains something that is not an address: ${bad.join(', ')}` };
  }
  return { ok: true };
}

export function isOwner(address: string | null): boolean {
  if (!address) return false;
  return adminConfig.owners.includes(address.toLowerCase());
}

/** The exact text an operator signs. Deliberately blunt about the stakes. */
export function adminSignInMessage(address: string, nonce: string): string {
  return [
    `${adminConfig.domain} — ADMIN sign-in`,
    address,
    '',
    'Signing grants this browser control of the agent operator panel:',
    'wallet balances, the approval queue, and token launches.',
    'It does not itself move funds; a launch is confirmed separately.',
    '',
    `Nonce: ${nonce}`,
  ].join('\n');
}

const b64u = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');
const sign = (payload: string): string =>
  createHmac('sha256', adminConfig.secret).update(payload).digest('base64url');

export interface AdminSession {
  subject: string;
  expiresAt: number;
}

export function mintAdminSession(address: string): string {
  const p = b64u(
    JSON.stringify({ t: 'admin', s: address.toLowerCase(), e: Date.now() + SESSION_TTL_MS }),
  );
  return `${p}.${sign(p)}`;
}

/**
 * Read a token, then check the allowlist again.
 *
 * The second check is not redundant: removing an address from ADMIN_ADDRESSES
 * has to revoke access immediately, and it cannot if the only check happened
 * when the still-valid token was minted.
 */
export function readAdminSession(token: string | undefined): AdminSession | null {
  if (!token || adminConfig.secret.length < 16) return null;
  const [p, mac] = token.split('.');
  if (!p || !mac) return null;

  const expected = Buffer.from(sign(p), 'utf8');
  const given = Buffer.from(mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  try {
    const body = JSON.parse(unb64u(p)) as { t?: string; s?: string; e?: number };
    if (body.t !== 'admin' || !body.s || !body.e) return null;
    if (body.e <= Date.now()) return null;
    if (!isOwner(body.s)) return null;
    return { subject: body.s, expiresAt: body.e };
  } catch {
    return null;
  }
}

export function issueAdminNonce(): string {
  return issueNonce();
}

/**
 * Check a signature, then spend the nonce.
 *
 * A non-owner is refused before the signature is even checked. Telling them
 * apart costs nothing here — the panel is not reachable from the internet, so
 * there is no enumeration to protect against, and a clear error saves an
 * operator ten minutes when they mistype their own address.
 */
export async function verifyAdminSignIn(opts: {
  address: string;
  signature: string;
  nonce: string;
}): Promise<{ ok: true; token: string; address: string } | { ok: false; error: string }> {
  const configured = adminConfigured();
  if (!configured.ok) return { ok: false, error: configured.error };

  let address: string;
  try {
    address = normaliseSubject('address', opts.address);
  } catch {
    return { ok: false, error: 'malformed address' };
  }
  if (!isOwner(address)) return { ok: false, error: 'that address is not in ADMIN_ADDRESSES' };

  const row = getDb()
    .prepare('SELECT issued_at, used FROM auth_nonces WHERE nonce = ?')
    .get(opts.nonce) as { issued_at: number; used: number } | undefined;
  if (!row) return { ok: false, error: 'unknown nonce' };
  if (row.used === 1) return { ok: false, error: 'nonce already used' };
  if (Date.now() - Number(row.issued_at) > NONCE_TTL_MS) return { ok: false, error: 'nonce expired' };

  let valid = false;
  try {
    valid = await verifyMessage({
      address: address as Address,
      message: adminSignInMessage(address, opts.nonce),
      signature: opts.signature as `0x${string}`,
    });
  } catch {
    return { ok: false, error: 'signature could not be checked' };
  }
  if (!valid) return { ok: false, error: 'signature does not match that address' };

  consumeNonce(opts.nonce);
  return { ok: true, token: mintAdminSession(address), address };
}
