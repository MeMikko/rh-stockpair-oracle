/**
 * A bound on the routes that must stay open for anyone to sign in.
 *
 * `/admin/nonce` and `/admin/verify` cannot sit behind the session gate — they
 * are how a session is obtained — so on a published panel they are the only
 * doors an unauthenticated caller can knock on. Unbounded, nonce issuance
 * grows a table on demand and signature verification burns CPU on demand, and
 * neither needs a vulnerability to hurt.
 *
 * In process and in memory on purpose: this is one small Node server, and a
 * limiter in Redis would be a second thing to run and a second thing to be
 * down. It resets on restart, which is the honest trade — a restart is rare
 * and an attacker cannot cause one from outside.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Keeps the map from growing without bound when many addresses knock once. */
const MAX_KEYS = 10_000;

export interface Limit {
  events: number;
  windowMs: number;
}

export function checkLimit(key: string, limit: Limit, now = Date.now()): {
  ok: boolean;
  retryAfterSeconds: number;
} {
  const w = windows.get(key);
  if (!w || w.resetAt <= now) {
    if (windows.size >= MAX_KEYS) {
      // Cheapest correct thing: drop what has already expired, and if nothing
      // has, drop the oldest. Never refuse a caller because the map is full —
      // that would turn a memory bound into a denial of service against the
      // operator.
      for (const [k, v] of windows) if (v.resetAt <= now) windows.delete(k);
      if (windows.size >= MAX_KEYS) windows.delete(windows.keys().next().value as string);
    }
    windows.set(key, { count: 1, resetAt: now + limit.windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }
  w.count += 1;
  if (w.count > limit.events) {
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }
  return { ok: true, retryAfterSeconds: 0 };
}

/** Test seam. */
export function resetLimits(): void {
  windows.clear();
}
