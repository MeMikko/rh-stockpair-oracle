import { answerQuestion } from '../src/answer/answer.js';
import { verifyDraft } from '../src/agent/verify.js';
import { enqueue } from '../src/agent/queue.js';
import {
  fetchMentions,
  neynarConfigured,
  saveMentionSignal,
  signalForMention,
  questionFromCast,
  unanswered,
  type Mention,
} from '../src/agent/mentions.js';
import { autonomyConfig, decide, recordAutoReply } from '../src/agent/autonomy.js';
import { tierForFid } from '../src/entitlements/index.js';
import { farcaster } from '../src/agent/publish/farcaster.js';

/**
 * Poll Farcaster mentions and answer them.
 *
 * By default every reply is queued for a person, exactly as a broadcast is.
 * With AGENT_AUTONOMOUS_REPLIES=pro, a mention from an entitled FID is
 * answered directly instead — and only that case. Everyone else still queues.
 *
 * Replying autonomously is defensible where posting autonomously is not: a
 * post is the agent's own claim that nobody asked for, while a reply is a
 * lookup somebody requested, produced by a path with no model in it and
 * checked by verifyDraft before it leaves. Broadcasts remain gated on a human
 * regardless of this setting.
 *
 *   npm run agent:listen                    # one pass over recent mentions
 *   npm run agent:listen -- --watch         # keep polling
 *   npm run agent:listen -- --question="how many pools quote NVDA"
 *   npm run agent:listen -- --dry-run       # decide, but send nothing
 *
 * A pro subscriber's mention can be answered without approval when
 * AGENT_AUTONOMOUS_REPLIES=pro; everyone else is queued as before. See
 * src/agent/autonomy.ts for why replying is a different proposition from
 * posting, and for the gates -- all of which default closed.
 */
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const channels = (process.env.AGENT_CHANNELS ?? 'farcaster')
  .split(',').map((s) => s.trim()).filter(Boolean);
const dryRun = flag('dry-run');

// Offline path: exercise the answer pipeline without touching Neynar. Useful
// for checking what the agent would say before pointing it at a real account.
const dryQuestion = arg('question');
if (dryQuestion) {
  const a = await answerQuestion(dryQuestion);
  console.log(`Q: ${dryQuestion}`);
  console.log(`   intent: ${a.intent.kind}${a.intent.symbol ? ` (${a.intent.symbol})` : ''}`);
  console.log(`   ${a.answered ? 'A' : 'NO ANSWER'}: ${a.text}`);
  console.log(`   reproduce: ${a.reproduce}`);
  process.exit(0);
}

const fid = process.env.NEYNAR_AGENT_FID?.trim();
if (!neynarConfigured() || !fid) {
  console.error(
    'listening needs NEYNAR_API_KEY and NEYNAR_AGENT_FID.\n' +
      'Without them, try a single question offline:\n' +
      '  npm run agent:listen -- --question="how many pools quote NVDA"',
  );
  process.exit(1);
}

const intervalMs = Number(arg('interval') ?? 120) * 1000;

async function pass(): Promise<number> {
  let mentions: Mention[];
  try {
    mentions = await fetchMentions(fid!);
  } catch (err) {
    console.error(`[listen] fetch failed: ${(err as Error).message.slice(0, 160)}`);
    return 0;
  }

  const fresh = unanswered(mentions);
  if (fresh.length === 0) return 0;

  let handled = 0;
  for (const m of fresh) {
    const { signal, answered, conversational } = await signalForMention(m);
    const worthSaying = answered || conversational;
    const verdict = decide({ fid: m.authorFid, answered: worthSaying });

    // An unanswerable mention is neither sent nor queued. Replying "I don't
    // know" to every passing mention would make the account noise, and there
    // is nothing for a person to approve either.
    if (!worthSaying) {
      console.log(`SKIP  @${m.author}: ${verdict.reason}`);
      continue;
    }

    const tier = m.authorFid ? tierForFid(m.authorFid).tier : 'free';
    const a = await answerQuestion(questionFromCast(m.text), new Date(), { tier });
    const verification = verifyDraft(a.text, signal.facts);
    if (!verification.ok) {
      // A template failing verification is a bug, not a rejection, so it is
      // loud -- and it blocks the autonomous path exactly as firmly as the
      // queued one. Nothing unverified is sent, approved or not.
      console.error(
        `SKIP  @${m.author}: answer failed verification ` +
          `(unsupported: ${verification.unsupported.join(', ') || 'none'})`,
      );
      continue;
    }

    if (verdict.autonomous) {
      if (dryRun) {
        console.log(`WOULD SEND  reply to @${m.author}  [${a.intent.kind}] — ${verdict.reason}`);
        console.log(`      A: ${a.text}\n`);
        handled++;
        continue;
      }
      const res = await farcaster.publish(a.text, false, m.hash);
      if (res.error) {
        // A failed send is not recorded as sent, so the next pass retries
        // rather than silently dropping someone's question.
        console.error(`FAIL  reply to @${m.author}: ${res.error}`);
        continue;
      }
      recordAutoReply({ castHash: m.hash, fid: m.authorFid!, intent: a.intent.kind, ref: res.ref });
      handled++;
      console.log(`SENT  reply to @${m.author}  [${a.intent.kind}]  ${res.ref ?? ''}`);
      console.log(`      why: ${verdict.reason}`);
      console.log(`      Q: ${m.text.slice(0, 120)}`);
      console.log(`      A: ${a.text}\n`);
      continue;
    }

    saveMentionSignal(signal);
    const post = enqueue(
      signal.id,
      { text: a.text, draftedBy: 'answer', verification },
      channels,
      m.hash,
    );
    if (!post) continue;

    handled++;
    console.log(`QUEUE ${post.id}  reply to @${m.author}  [${a.intent.kind}]`);
    console.log(`      queued because: ${verdict.reason}`);
    console.log(`      Q: ${m.text.slice(0, 120)}`);
    console.log(`      A: ${a.text}`);
    console.log(`      reproduce: ${a.reproduce}\n`);
  }
  return handled;
}

console.log(
  `autonomy: ${autonomyConfig.mode}` +
    (autonomyConfig.mode === 'pro'
      ? ` (entitled FIDs answered directly; <=${autonomyConfig.perFidDaily}/fid/day, ` +
        `<=${autonomyConfig.dailyCap}/day total)`
      : ' (every reply goes to the approval queue)') +
    (dryRun ? ' | DRY RUN, nothing will be sent' : ''),
);

const first = await pass();
console.log(
  `\n${first} mention(s) handled. Queued drafts are sent only after approval:\n` +
    '  npm run agent:queue\n  npm run agent:approve -- <id>\n  npm run agent:publish -- --live',
);

if (flag('watch')) {
  console.log(`\nwatching for mentions every ${intervalMs / 1000}s -- ctrl-c to stop`);
  setInterval(() => {
    void pass().then((n) => {
      if (n > 0) console.log(`${n} new mention(s) handled`);
    });
  }, intervalMs);
}
