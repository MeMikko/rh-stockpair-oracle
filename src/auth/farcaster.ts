import { getDb } from '../db/index.js';
import { grant, lookup, normaliseSubject } from '../entitlements/index.js';

/**
 * Linking a Farcaster account to an address that has already paid.
 *
 * Necessary because the two surfaces key on different subjects: a payment
 * entitles an *address*, while autonomous replies check an *FID*. Without a
 * link, buying pro does nothing on Farcaster and every subscriber has to be
 * granted by hand.
 *
 * The link is proved rather than claimed, which is the only reason this can be
 * self-service. Farcaster accounts publish the addresses they have verified,
 * so the question "does this person control both?" has an answer that neither
 * we nor the user gets to assert: we ask Neynar which addresses the FID has
 * verified, and require the signed-in address to be among them. Someone
 * claiming another person's FID fails on that list.
 */

export interface LinkResult {
  ok: boolean;
  error?: string;
  fid?: string;
  address?: string;
  expiresAt?: number | null;
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
      signal: AbortSignal.timeout(20_000),
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

  // Both shapes are read: `verifications` is the older flat list and
  // `verified_addresses.eth_addresses` the current one. Taking the union
  // rather than picking one means a response shape change degrades to fewer
  // matches instead of no matches at all.
  const all = [...(u.verified_addresses?.eth_addresses ?? []), ...(u.verifications ?? [])];
  return [...new Set(all.map((a) => a.toLowerCase()))];
}

/**
 * Mirror a paid address's entitlement onto its Farcaster account.
 *
 * The FID inherits the address's expiry rather than getting a fresh period:
 * one payment buys one period, and issuing a second clock for the same money
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

  const verified = await verifiedAddressesForFid(fid);
  if (verified === null) {
    return { ok: false, error: 'could not reach Farcaster to check that FID; try again shortly' };
  }
  if (!verified.includes(addr)) {
    return {
      ok: false,
      error:
        `FID ${fid} has not verified ${addr}. Verify this address on your Farcaster ` +
        `account, or sign in with an address that FID already verified.`,
    };
  }

  grant('fid', fid, {
    tier: ent.tier,
    expiresAt: ent.expiresAt,
    source: `linked:address:${addr}`,
    note: 'verified on Farcaster',
  });
  // Recorded so a later renewal can find the FIDs to extend without asking
  // Neynar again.
  getDb()
    .prepare(
      `INSERT INTO fid_links (fid, address, linked_at) VALUES (?, ?, ?)
       ON CONFLICT(fid) DO UPDATE SET address = excluded.address, linked_at = excluded.linked_at`,
    )
    .run(fid, addr, Date.now());

  return { ok: true, fid, address: addr, expiresAt: ent.expiresAt };
}

/** FIDs linked to an address, so a renewal can extend them too. */
export function linkedFids(address: string): string[] {
  const rows = getDb()
    .prepare('SELECT fid FROM fid_links WHERE address = ?')
    .all(address.toLowerCase()) as unknown as Array<{ fid: string }>;
  return rows.map((r) => r.fid);
}
