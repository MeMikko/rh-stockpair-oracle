import { getDb } from '../db/index.js';
import { grant, lookup, normaliseSubject, revoke } from '../entitlements/index.js';

/**
 * Linking a Farcaster account to an address that has already paid.
 *
 * Necessary because the two surfaces key on different subjects: a payment
 * entitles an *address*, while autonomous replies check an *FID*.
 *
 * **The FID is taken on trust.** Requiring the payer to be an address the FID
 * has verified sounds stricter and is mostly friction: a Farcaster account's
 * verified wallet is often one people would have to export and import before
 * they could pay with it, and most will not. So the claim is accepted.
 *
 * That is defensible because of what is *not* being trusted. A mention's FID
 * still comes from Neynar, so nobody can impersonate an account. All a false
 * claim can do is hand the service to someone else — the payment is made
 * either way, and the recipient can do nothing the payer could not. The one
 * real cost is the shared daily reply budget, which is why an address holds
 * one FID at a time: linking a second replaces the first rather than
 * accumulating.
 *
 * Verification is still checked, best effort, and recorded — it costs nothing
 * to know, and "verified" is worth more than "claimed" if a dispute ever
 * arises. It never blocks.
 */

export interface LinkResult {
  ok: boolean;
  error?: string;
  fid?: string;
  address?: string;
  expiresAt?: number | null;
  /** Whether the FID had actually verified the paying address. */
  verified?: boolean;
  /** The FID this replaced, when the address had already linked one. */
  replaced?: string;
}

/** Addresses a Farcaster account has verified, as reported by Neynar. */
export async function verifiedAddressesForFid(fid: string): Promise<string[] | null> {
  const key = process.env.NEYNAR_API_KEY?.trim();
  if (!key) return null;

  const url = new URL('https://api.neynar.com/v2/farcaster/user/bulk/');
  url.searchParams.set('fids', fid);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'x-api-key': key, accept: 'application/json' },
      // Short: this is informational, and a slow lookup must not hold up a
      // link that does not depend on the answer.
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const body = (await res.json()) as {
    users?: Array<{
      verified_addresses?: { eth_addresses?: string[] };
      verifications?: string[];
    }>;
  };
  const u = body.users?.[0];
  if (!u) return null;

  // Both shapes are read -- `verifications` is the older flat list and
  // `verified_addresses.eth_addresses` the current one -- and unioned, so a
  // change at Neynar's end degrades to fewer matches rather than none.
  const all = [...(u.verified_addresses?.eth_addresses ?? []), ...(u.verifications ?? [])];
  return [...new Set(all.map((a) => a.toLowerCase()))];
}

/** The FID this address currently holds, if any. */
export function currentFidFor(address: string): string | null {
  const r = getDb()
    .prepare('SELECT fid FROM fid_links WHERE address = ?')
    .get(address.toLowerCase()) as { fid: string } | undefined;
  return r?.fid ?? null;
}

/**
 * Mirror a paid address's entitlement onto a Farcaster account.
 *
 * The FID inherits the address's existing expiry rather than getting a fresh
 * period: one payment buys one period, and a second clock for the same money
 * is how a subscription quietly becomes free.
 */
export async function linkFid(address: string, fidRaw: string): Promise<LinkResult> {
  let addr: string;
  let fid: string;
  try {
    addr = normaliseSubject('address', address);
    fid = normaliseSubject('fid', fidRaw);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const ent = lookup('address', addr);
  if (!ent) return { ok: false, error: 'that address has no entitlement; buy pro first' };
  if (ent.expiresAt !== null && ent.expiresAt <= Date.now()) {
    return { ok: false, error: 'that entitlement has expired; buy another period first' };
  }

  // Refuse to take an FID another payer is already using. Without this, one
  // person could displace another's paid link by claiming their FID.
  const held = getDb()
    .prepare('SELECT address FROM fid_links WHERE fid = ?')
    .get(fid) as { address: string } | undefined;
  if (held && held.address !== addr) {
    return { ok: false, error: `FID ${fid} is already linked to another subscription` };
  }

  // Informational only. A failed lookup is not a failed link.
  const verifiedList = await verifiedAddressesForFid(fid);
  const verified = verifiedList !== null && verifiedList.includes(addr);

  // One FID per paying address. Linking another replaces it, so a single
  // subscription cannot spread across many accounts and drain the shared
  // daily reply budget.
  const previous = currentFidFor(addr);
  if (previous && previous !== fid) revoke('fid', previous);

  grant('fid', fid, {
    tier: ent.tier,
    expiresAt: ent.expiresAt,
    source: `linked:${verified ? 'verified' : 'claimed'}:${addr}`,
    note: verified ? 'address verified on Farcaster' : 'FID supplied by the payer',
  });

  const db = getDb();
  db.exec('BEGIN');
  try {
    if (previous && previous !== fid) {
      db.prepare('DELETE FROM fid_links WHERE fid = ?').run(previous);
    }
    db.prepare(
      `INSERT INTO fid_links (fid, address, linked_at) VALUES (?, ?, ?)
       ON CONFLICT(fid) DO UPDATE SET address = excluded.address, linked_at = excluded.linked_at`,
    ).run(fid, addr, Date.now());
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    ok: true,
    fid,
    address: addr,
    expiresAt: ent.expiresAt,
    verified,
    replaced: previous && previous !== fid ? previous : undefined,
  };
}

/** FIDs linked to an address, so a renewal can extend them too. */
export function linkedFids(address: string): string[] {
  const rows = getDb()
    .prepare('SELECT fid FROM fid_links WHERE address = ?')
    .all(address.toLowerCase()) as unknown as Array<{ fid: string }>;
  return rows.map((r) => r.fid);
}
