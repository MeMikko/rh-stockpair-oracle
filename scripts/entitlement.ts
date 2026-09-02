import { tolerateClosedPipe } from '../src/util/stdout.js';
import {
  grant, revoke, listEntitlements, lookup, resolve,
  InvalidSubject, type SubjectType, type Tier,
} from '../src/entitlements/index.js';

tolerateClosedPipe();

/**
 * Manage entitlements by hand.
 *
 * Exists before any payment path does, deliberately: granting pro manually is
 * how the whole gated flow gets exercised end to end before money is involved.
 *
 *   npm run ent -- grant fid 12345 --days=30 --note="early tester"
 *   npm run ent -- grant address 0xabc… --source=payment:0xdeadbeef
 *   npm run ent -- check fid 12345
 *   npm run ent -- revoke fid 12345
 *   npm run ent -- list [--all]
 */
const [cmd, typeArg, subjectArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const usage = () => {
  console.log('usage:');
  console.log('  ent grant  <fid|address> <subject> [--tier=pro] [--days=N] [--source=…] [--note=…]');
  console.log('  ent revoke <fid|address> <subject>');
  console.log('  ent check  <fid|address> <subject>');
  console.log('  ent list   [--all]');
  process.exit(1);
};

const asType = (v: string | undefined): SubjectType => {
  if (v === 'fid' || v === 'address') return v;
  usage();
  throw new Error('unreachable');
};

const when = (ts: number | null): string =>
  ts === null ? 'never' : new Date(ts).toISOString().replace('T', ' ').slice(0, 16);

try {
  switch (cmd) {
    case 'grant': {
      if (!typeArg || !subjectArg) usage();
      const days = arg('days') ? Number(arg('days')) : null;
      const e = grant(asType(typeArg), subjectArg!, {
        tier: (arg('tier') as Tier) ?? 'pro',
        expiresAt: days === null ? null : Date.now() + days * 86_400_000,
        source: arg('source') ?? 'manual',
        note: arg('note'),
      });
      console.log(`granted ${e.tier} to ${e.subjectType}:${e.subject}`);
      console.log(`  expires ${when(e.expiresAt)} | source ${e.source}${e.note ? ` | ${e.note}` : ''}`);
      break;
    }

    case 'revoke': {
      if (!typeArg || !subjectArg) usage();
      const gone = revoke(asType(typeArg), subjectArg!);
      console.log(gone ? `revoked ${typeArg}:${subjectArg}` : `nothing on record for ${typeArg}:${subjectArg}`);
      break;
    }

    case 'check': {
      if (!typeArg || !subjectArg) usage();
      const t = asType(typeArg);
      const stored = lookup(t, subjectArg!);
      console.log(`stored   : ${stored ? `${stored.tier}, expires ${when(stored.expiresAt)}` : 'none'}`);
      // Both assertions are shown because the difference is the point: a
      // claimed identity never inherits an entitlement, and seeing that here
      // is cheaper than discovering it in production.
      const v = resolve(t, subjectArg!, 'verified');
      const c = resolve(t, subjectArg!, 'claimed');
      console.log(`verified : ${v.tier}  (${v.reason})`);
      console.log(`claimed  : ${c.tier}  (${c.reason})`);
      break;
    }

    case 'list': {
      const all = listEntitlements(flag('all'));
      if (all.length === 0) {
        console.log(flag('all') ? 'no entitlements on record' : 'no active entitlements');
        break;
      }
      console.log(`${all.length} entitlement(s)${flag('all') ? ' (including expired)' : ''}`);
      for (const e of all) {
        console.log(
          `  ${e.tier.padEnd(4)} ${`${e.subjectType}:${e.subject}`.padEnd(46)} ` +
            `expires ${when(e.expiresAt).padEnd(17)} ${e.source}${e.note ? ` — ${e.note}` : ''}`,
        );
      }
      break;
    }

    default:
      usage();
  }
} catch (err) {
  if (err instanceof InvalidSubject) {
    console.error(`error: ${err.message}`);
    process.exit(2);
  }
  throw err;
}
