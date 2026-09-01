/**
 * Retry with exponential backoff, aimed at the public RPC's 429s and
 * server-side timeouts. Kept separate from viem's transport-level retry so
 * whole multi-call operations (not just single requests) can be re-attempted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const base = opts.baseMs ?? 2_000;
  let lastErr: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = base * 2 ** i;
      if (opts.label) {
        console.warn(`[retry] ${opts.label} failed (attempt ${i + 1}/${attempts}), waiting ${delay}ms`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
