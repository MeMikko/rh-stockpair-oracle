import { describe, it, expect } from 'vitest';
import { adminPage } from '../src/admin/page.js';

/**
 * The panel is one string, so nothing type-checks it.
 *
 * A duplicate id costs nothing at build time and everything at run time:
 * `getElementById` returns the first match in document order, so the second
 * element silently loses its handler while the first silently gains one. That
 * shipped — the compose button and the queue listing both carried id="queue",
 * which left the button dead and made a stray click anywhere in the queue
 * listing submit a post instead.
 */
const html = adminPage();

/** Every id="..." in the rendered page, in document order. */
function ids(page: string): string[] {
  return [...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string);
}

/** Every id the script looks up through the $ helper. */
function looked(page: string): string[] {
  return [...page.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1] as string);
}

describe('the admin page', () => {
  it('gives every element its own id', () => {
    const seen = ids(html);
    const duplicates = seen.filter((id, i) => seen.indexOf(id) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });

  /**
   * The other half of the same failure: a handler bound to an id that the
   * markup never defines is as dead as one bound to the wrong element, and
   * just as quiet.
   */
  it('looks up only ids the markup defines', () => {
    const defined = new Set(ids(html));
    const missing = [...new Set(looked(html))].filter((id) => !defined.has(id));
    expect(missing).toEqual([]);
  });

  /**
   * WalletConnect loads third-party code onto the one page whose process holds
   * the wallet-scoped Bankr key. Unconfigured, the button must not be offered
   * at all — an operator clicking a dead button learns nothing, and a page that
   * reaches for an SDK it has no project id for is worse than one that does not.
   */
  it('hides WalletConnect when no project id is configured', () => {
    expect(html).toContain('id="wcconnect" hidden');
  });

  /**
   * The way in that needs nothing from the browser. Whatever is wrong with a
   * given machine's wallet, the server only ever checks a signature over a
   * nonce it issued, so signing elsewhere is the same check.
   */
  it('offers a sign-elsewhere route that needs no injected wallet', () => {
    const defined = new Set(ids(html));
    for (const id of ['manualsign', 'maddr', 'mnonce', 'mmsg', 'msig', 'msubmit', 'mout']) {
      expect(defined.has(id), `missing #${id}`).toBe(true);
    }
  });

  /** Two reports of "the button does nothing" were diagnosed from the outside. */
  it('says in the page what the browser offers', () => {
    expect(html).toContain('walletdiag');
    expect(html).toContain('isSecureContext');
  });

  it('still has the compose controls, under ids of their own', () => {
    const defined = new Set(ids(html));
    for (const id of ['signal', 'ptext', 'check', 'composequeue', 'composeout']) {
      expect(defined.has(id), `missing #${id}`).toBe(true);
    }
  });
});
