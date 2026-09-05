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

  it('still has the compose controls, under ids of their own', () => {
    const defined = new Set(ids(html));
    for (const id of ['signal', 'ptext', 'check', 'composequeue', 'composeout']) {
      expect(defined.has(id), `missing #${id}`).toBe(true);
    }
  });
});
