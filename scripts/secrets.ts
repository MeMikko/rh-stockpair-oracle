import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Fill in the secrets this project can generate, and name the ones it cannot.
 *
 * The distinction is the point. A salt is ours to invent; an API key is issued
 * by someone else and inventing one produces a file that looks configured and
 * fails at the first call. So generated values are written and external ones
 * are only ever reported as missing.
 *
 * Never overwrites a value that is already set. This edits the file holding
 * live credentials on a production box, so the only safe default is to add.
 *
 *   npm run secrets            # fill what is missing, report the rest
 *   npm run secrets -- --show  # also print generated values
 *   npm run secrets -- --rotate=USAGE_SALT
 */

/** Secrets with no external authority: we can just make one up, safely. */
const GENERATED: Record<string, { bytes: number; note: string }> = {
  USAGE_SALT: {
    bytes: 32,
    note: 'hashes caller addresses in the usage counter; rotating it resets caller identity, not counts',
  },
  NEYNAR_WEBHOOK_SECRET: {
    bytes: 32,
    note: 'MUST match the secret Neynar shows for the webhook — if Neynar issued one, paste theirs instead',
  },
};

/** Issued elsewhere. Generating a value here would only fake being configured. */
const EXTERNAL: Record<string, string> = {
  ALCHEMY_API_KEY: 'alchemy.com — state and archive reads',
  BLOCKSCOUT_API_KEY: 'dev.blockscout.com — explorer, optional',
  NEYNAR_API_KEY: 'dev.neynar.com — required to read mentions or cast',
  NEYNAR_SIGNER_UUID: 'dev.neynar.com — must be an approved signer, made with the same API key',
  NEYNAR_AGENT_FID: "the agent account's own FID, not yours",
  BANKR_LLM_API_KEY: 'llm.bankr.bot — optional; without it drafts fall back to templates',
};

const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const envPath = resolve(process.env.ENV_FILE ?? '.env');
const examplePath = resolve('.env.example');

if (!existsSync(envPath)) {
  if (!existsSync(examplePath)) {
    console.error(`neither ${envPath} nor .env.example exists; nothing to work from`);
    process.exit(1);
  }
  copyFileSync(examplePath, envPath);
  console.log(`created ${envPath} from .env.example`);
}

let text = readFileSync(envPath, 'utf8');
const valueOf = (key: string): string | null => {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1]!.trim() : null;
};

/** Set a key, replacing the line in place when present so order and comments survive. */
function setValue(key: string, value: string): void {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n*$/, '\n')}${line}\n`;
}

const rotate = arg('rotate');
if (rotate && !(rotate in GENERATED)) {
  console.error(`cannot rotate ${rotate}: it is issued externally, not generated here`);
  process.exit(2);
}

const generated: string[] = [];
for (const [key, spec] of Object.entries(GENERATED)) {
  const current = valueOf(key);
  const empty = current === null || current === '';
  if (!empty && rotate !== key) continue;
  setValue(key, randomBytes(spec.bytes).toString('hex'));
  generated.push(key);
}

if (generated.length > 0) {
  // Written through a temp file and renamed: a crash mid-write must not leave
  // a truncated .env on a box where that file is the only copy of the
  // credentials.
  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, envPath);
}
try {
  chmodSync(envPath, 0o600);
} catch {
  /* not all filesystems support it; not worth failing over */
}

console.log(`\n${envPath}\n`);

if (generated.length === 0) {
  console.log('generated secrets: all present, nothing changed');
} else {
  for (const key of generated) {
    const action = rotate === key ? 'rotated' : 'generated';
    console.log(`  ${action}  ${key}`);
    console.log(`            ${GENERATED[key]!.note}`);
    if (flag('show')) console.log(`            ${valueOf(key)}`);
  }
  if (!flag('show')) console.log('\n  (re-run with --show to print the values)');
}

const missing = Object.entries(EXTERNAL).filter(([k]) => {
  const v = valueOf(k);
  return v === null || v === '';
});

console.log('');
if (missing.length === 0) {
  console.log('external secrets: all set');
} else {
  console.log(`external secrets still missing (${missing.length}) — these must be issued elsewhere:`);
  for (const [k, where] of missing) console.log(`  ${k.padEnd(22)} ${where}`);
}

if (generated.includes('NEYNAR_WEBHOOK_SECRET')) {
  console.log(
    '\nNEYNAR_WEBHOOK_SECRET was generated. It has to be IDENTICAL on both sides:\n' +
      '  - if the Neynar dashboard issued a secret for your webhook, paste that one here instead;\n' +
      '  - if it lets you set one, copy the generated value into the dashboard.\n' +
      'A mismatch rejects every delivery with 401, and the fault looks like a bug in this code.',
  );
}
