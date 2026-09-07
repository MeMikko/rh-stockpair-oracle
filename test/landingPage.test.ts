import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The public page, rendered through the route a stranger would hit.
 *
 * Two things worth asserting and neither was: that the inline script parses,
 * and that the site-verification tag is still there.
 *
 * The first is the same latent bug that killed the operator panel — a script
 * built as a template literal inside a .ts file, where tsc checks the string
 * and never parses the JavaScript in it. A syntax error there is not one dead
 * handler, it is a dead page, and on this page that is the page every caller
 * and every crawler sees.
 */
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'landing-')), 'test.db');

const { registerLanding } = await import('../src/api/routes/landing.js');

const app = Fastify();
let html = '';

beforeAll(async () => {
  registerLanding(app);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: '/', headers: { accept: 'text/html' } });
  expect(res.statusCode).toBe(200);
  html = res.body;
});

afterAll(async () => { await app.close(); });

describe('the landing page', () => {
  it('emits JavaScript that actually parses', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script, 'the page should have an inline script').toBeTruthy();
    expect(() => new Function(script as string)).not.toThrow();
  });

  /**
   * A verification tag proves control of this origin to a registry. Losing it
   * does not break the page, which is exactly why it would go unnoticed until
   * the agent quietly stopped being listed — so the token is asserted
   * verbatim rather than merely "present".
   */
  it('carries the Virtuals Protocol site verification', () => {
    expect(html).toContain(
      '<meta name="virtual-protocol-site-verification" content="265f4d0d1820438077fd872cd715f2c8">',
    );
  });

  it('still says what the service is', () => {
    expect(html).toContain('<meta name="description"');
    expect(html).toMatch(/<title>[^<]+<\/title>/);
  });
});
