import { execFileSync } from 'node:child_process';

/**
 * One periodic maintenance pass, for the systemd timer.
 *
 * Each step runs as its own process so one failing sync cannot abort the
 * others: the registry going down should not stop the corporate calendar from
 * refreshing. Steps are ordered cheapest-first, and volume last because it is
 * the only one that takes an hour.
 */
const steps = [
  ['registry', 'scripts/sync-registry.ts', []],
  ['corporate', 'scripts/sync-corporate.ts', []],
  ['holders', 'scripts/sync-holders.ts', ['--stock']],
  ['volume', 'scripts/sync-volume.ts', ['--hours=24']],
] as const;

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
let failed = 0;

for (const [name, script, args] of steps) {
  if (only && only !== name) continue;
  const started = Date.now();
  process.stdout.write(`[sync] ${name} ... `);
  try {
    execFileSync(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3 * 60 * 60 * 1000,
    });
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  } catch (err) {
    failed++;
    const e = err as { stderr?: Buffer; message?: string };
    console.log(
      `FAILED (${((Date.now() - started) / 1000).toFixed(0)}s): ` +
        `${(e.stderr?.toString() || e.message || '').split('\n').slice(-3).join(' ').slice(0, 300)}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} step(s) failed`);
  process.exitCode = 1;
}
