import { isAddress } from 'viem';
import { getDb } from '../db/index.js';

/**
 * Who is entitled to what, and — just as importantly — who says so.
 *
 * This is the whole of the agent's memory, and it is deliberately the
 * narrowest useful shape: it records entitlement, never conversation. An agent
 * that remembers what it was told can be taught to believe something; an agent
 * that only remembers who paid cannot. Nothing here feeds the answer path.
 *
 * **Trust is a property of the source, not the subject.** An FID that arrives
 * from Neynar's API is asserted by Neynar. An FID or address that arrives in
 * an HTTP request is asserted by whoever sent the request, and anyone can
 * claim to be anyone. Both are stored identically, so the distinction has to
 * live at the call site — which is why `resolve` demands it explicitly rather
 * than inferring it.
 */

export type Tier = 'free' | 'pro';
export type SubjectType = 'fid' | 'address';

/**
 * How the caller's identity was established.
 *
 *  - `verified`: a third party we trust asserted it (Neynar for a mention's
 *    FID), or the caller proved it with a signature.
 *  - `claimed`: the caller simply said so. Usable for telemetry and for
 *    self-service lookups; never sufficient to grant anything of value.
 */
export type Assertion = 'verified' | 'claimed';

export interface Entitlement {
  subjectType: SubjectType;
  subject: string;
  tier: Tier;
  grantedAt: number;
  expiresAt: number | null;
  source: string;
  note: string | null;
}

export class InvalidSubject extends Error {}

/**
 * Canonical form for a subject, so the same person cannot hold two rows.
 * FIDs are digits; addresses are lowercased and checked, because a mixed-case
 * address and its lowercase form would otherwise be different primary keys.
 */
export function normaliseSubject(type: SubjectType, value: string): string {
  const v = value.trim();
  if (type === 'fid') {
    if (!/^\d{1,20}$/.test(v)) throw new InvalidSubject(`not a Farcaster FID: ${value}`);
    return String(BigInt(v));
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new InvalidSubject(`not an EVM address: ${value}`);
  }

  // Checksum is enforced only when the input is mixed case, and that split is
  // deliberate. An all-lowercase address is the canonical form we store and
  // carries no checksum to check, so demanding one would reject the shape this
  // module itself produces. A mixed-case address is *claiming* to be
  // checksummed, so a mismatch means a typo -- and a typo here silently grants
  // pro to an address nobody controls.
  const mixedCase = v !== v.toLowerCase() && v !== v.toUpperCase();
  if (mixedCase && !isAddress(v, { strict: true })) {
    throw new InvalidSubject(`address checksum does not match, likely a typo: ${value}`);
  }

  return v.toLowerCase();
}

function row2ent(r: Record<string, unknown>): Entitlement {
  return {
    subjectType: String(r.subject_type) as SubjectType,
    subject: String(r.subject),
    tier: String(r.tier) as Tier,
    grantedAt: Number(r.granted_at),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : Number(r.expires_at),
    source: String(r.source),
    note: r.note === null || r.note === undefined ? null : String(r.note),
  };
}

export function grant(
  subjectType: SubjectType,
  subject: string,
  opts: { tier?: Tier; expiresAt?: number | null; source?: string; note?: string } = {},
): Entitlement {
  const key = normaliseSubject(subjectType, subject);
  const tier = opts.tier ?? 'pro';
  getDb()
    .prepare(
      `INSERT INTO entitlements (subject_type, subject, tier, granted_at, expires_at, source, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_type, subject) DO UPDATE SET
         tier = excluded.tier, granted_at = excluded.granted_at,
         expires_at = excluded.expires_at, source = excluded.source, note = excluded.note`,
    )
    .run(
      subjectType, key, tier, Date.now(),
      opts.expiresAt ?? null, opts.source ?? 'manual', opts.note ?? null,
    );
  return lookup(subjectType, key)!;
}

export function revoke(subjectType: SubjectType, subject: string): boolean {
  const key = normaliseSubject(subjectType, subject);
  const r = getDb()
    .prepare('DELETE FROM entitlements WHERE subject_type = ? AND subject = ?')
    .run(subjectType, key);
  return Number(r.changes) > 0;
}

/** The stored row, expired or not. Use `tierOf` for the effective tier. */
export function lookup(subjectType: SubjectType, subject: string): Entitlement | null {
  const key = normaliseSubject(subjectType, subject);
  const r = getDb()
    .prepare('SELECT * FROM entitlements WHERE subject_type = ? AND subject = ?')
    .get(subjectType, key) as Record<string, unknown> | undefined;
  return r ? row2ent(r) : null;
}

export function listEntitlements(includeExpired = false): Entitlement[] {
  const rows = getDb()
    .prepare('SELECT * FROM entitlements ORDER BY granted_at DESC')
    .all() as Record<string, unknown>[];
  const all = rows.map(row2ent);
  if (includeExpired) return all;
  const now = Date.now();
  return all.filter((e) => e.expiresAt === null || e.expiresAt > now);
}

export interface Resolution {
  tier: Tier;
  assertion: Assertion;
  subjectType: SubjectType | null;
  subject: string | null;
  /** Why the tier is what it is. Surfaced so a caller can see the reason. */
  reason: string;
}

export const ANONYMOUS: Resolution = {
  tier: 'free',
  assertion: 'claimed',
  subjectType: null,
  subject: null,
  reason: 'no subject presented',
};

/**
 * Effective tier for a subject.
 *
 * `assertion` is required rather than optional. A merely claimed identity
 * never resolves above free: without it, an HTTP caller could send someone
 * else's FID and inherit their entitlement, which is the obvious hole and the
 * easy one to leave open by accident. Verified identities today mean an FID
 * that Neynar reported for a real mention; signature-proved identities can
 * join them without changing anything here.
 */
export function resolve(
  subjectType: SubjectType,
  subject: string,
  assertion: Assertion,
): Resolution {
  let key: string;
  try {
    key = normaliseSubject(subjectType, subject);
  } catch {
    return { ...ANONYMOUS, reason: `malformed ${subjectType}` };
  }

  const base = { subjectType, subject: key };
  const ent = lookup(subjectType, key);

  if (!ent) return { ...base, tier: 'free', assertion, reason: 'no entitlement on record' };
  if (ent.expiresAt !== null && ent.expiresAt <= Date.now()) {
    return { ...base, tier: 'free', assertion, reason: 'entitlement expired' };
  }
  if (assertion !== 'verified') {
    return {
      ...base,
      tier: 'free',
      assertion,
      reason: 'identity claimed but not verified; entitlement not applied',
    };
  }
  return { ...base, tier: ent.tier, assertion, reason: `entitled until ${ent.expiresAt ?? 'revoked'}` };
}

/** Convenience for the mention path, where Neynar asserts the FID. */
export function tierForFid(fid: string | number): Resolution {
  return resolve('fid', String(fid), 'verified');
}
