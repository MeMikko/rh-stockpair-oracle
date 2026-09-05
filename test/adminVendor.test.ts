import { describe, it, expect, beforeEach } from 'vitest';
import { walletConnectBundle, resetVendorCache } from '../src/admin/vendor.js';

/**
 * The bundle the panel loads to sign in with a phone.
 *
 * Worth a real build rather than a mock: the two shortcuts that would have
 * saved this file both produce something that loads and then fails. A CDN
 * import works until the CDN serves something else; the published UMD build
 * looks self-contained and reads viem, lit and bs58 off the global object, so
 * it yields a provider whose dependencies are all undefined. Building it here
 * is what tells us the file the browser gets is the file that works.
 */
beforeEach(() => resetVendorCache());

describe('the WalletConnect bundle', () => {
  it('builds, and exports what the page imports', async () => {
    const js = await walletConnectBundle();
    expect(js.length).toBeGreaterThan(100_000);
    // esbuild renames on minify, so the export list is the thing to look at:
    // the page does `import('/admin/vendor/walletconnect.js')` and reads
    // `.EthereumProvider` off it.
    expect(js).toMatch(/export\s*\{[^}]*as EthereumProvider/);
  }, 60_000);

  /**
   * `process` does not exist in a browser. A bundle that references it throws
   * on load rather than on use, which is the least debuggable moment there is.
   */
  it('carries no bare reference to process.env', async () => {
    const js = await walletConnectBundle();
    expect(js).not.toContain('process.env.NODE_ENV');
  }, 60_000);

  it('builds once and serves the same text after that', async () => {
    const first = await walletConnectBundle();
    const second = await walletConnectBundle();
    expect(second).toBe(first);
  }, 60_000);

  /** Two operators opening the panel at once must not start two builds. */
  it('shares one build between concurrent first requests', async () => {
    const [a, b] = await Promise.all([walletConnectBundle(), walletConnectBundle()]);
    expect(a).toBe(b);
  }, 60_000);
});
