import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * The WalletConnect provider, bundled here and served from this origin.
 *
 * Three ways to get this code into the page, and the first two were rejected:
 *
 *  - **A CDN** (`esm.sh`, `unpkg`) is one line and no build. It also puts a
 *    third party in a position to serve arbitrary script to the one page whose
 *    process holds the wallet-scoped Bankr key, on every sign-in, forever.
 *    Nothing else on this page is fetched from anywhere.
 *  - **The published UMD build** looks self-contained and is not. Its browser
 *    branch reads viem, lit, bs58, qrcode, valtio and big.js off the global
 *    object, so `dist/index.umd.js` in a `<script>` yields a provider whose
 *    dependencies are all `undefined`.
 *
 * So it is bundled from this repository's own `node_modules`, pinned by
 * `package-lock.json`, by the process that serves it. Built on first request
 * rather than at deploy time: it takes about a third of a second, most panels
 * never load it, and a build step nobody runs is a build step that rots.
 *
 * The result is cached for the life of the process. Restarting the unit after
 * an `npm install` is what picks up a new version, which is the same rule as
 * every other module here.
 */

let cached: string | null = null;
let building: Promise<string> | null = null;

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [resolve(process.cwd(), 'vendor/walletconnect-entry.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    write: false,
    // The package reads process.env.NODE_ENV. Without this the bundle carries
    // a reference to `process`, which does not exist in a browser, and the
    // module throws on load rather than on use — the least debuggable moment.
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild produced no output');
  return out.text;
}

export async function walletConnectBundle(): Promise<string> {
  if (cached) return cached;
  // Concurrent first requests share one build rather than starting several.
  building ??= bundle().then(
    (text) => { cached = text; building = null; return text; },
    (err) => { building = null; throw err; },
  );
  return building;
}

/** Test seam: forget the cached bundle. */
export function resetVendorCache(): void {
  cached = null;
  building = null;
}
