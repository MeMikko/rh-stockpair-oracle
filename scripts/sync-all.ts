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
  console.log(`[sync] ${name} starting`);
  try {
    // Inherit stdio rather than capture it. The volume step runs for an hour
    // and its progress output is the only sign it is alive; buffering that
    // until the child exits makes a working sync indistinguishable from a
    // hung one -- which is exactly how it looked the first time this ran
    // under systemd. journald captures the child's own output, so nothing is
    // lost by not reading it here, and a crash explains itself in place.
    execFileSync(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', script, ...args], {
      stdio: 'inherit',
      timeout: 3 * 60 * 60 * 1000,
    });
    console.log(`[sync] ${name} ok (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  } catch (err) {
    failed++;
    // Only the exit status is reported, because that is all this wrapper
    // knows. Taking the tail of captured stderr looked informative and was
    // not: for a Node crash those lines are the version banner, so a failing
    // step reported "FAILED: Node.js v22.22.1" and nothing about the cause.
    const e = err as { status?: number; signal?: string };
    console.error(
      `[sync] ${name} FAILED (${((Date.now() - started) / 1000).toFixed(0)}s) ` +
        `exit=${e.status ?? '?'}${e.signal ? ` signal=${e.signal}` : ''} — its own error output is above.`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} step(s) failed`);
  process.exitCode = 1;
}
