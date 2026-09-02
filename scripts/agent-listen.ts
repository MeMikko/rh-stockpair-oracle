import { answerQuestion } from '../src/answer/answer.js';
import { verifyDraft } from '../src/agent/verify.js';
import { enqueue } from '../src/agent/queue.js';
import {
  fetchMentions,
  neynarConfigured,
  saveMentionSignal,
  signalForMention,
  unanswered,
  type Mention,
} from '../src/agent/mentions.js';

/**
 * Poll Farcaster mentions and queue a reply to each, for human approval.
 *
 * The agent answers, but it never answers on its own authority: a reply is a
 * public claim from the same account that publishes the feed, so it lands in
 * the same queue behind the same approval as a broadcast. This script only
 * ever writes drafts.
 *
 *   npm run agent:listen                    # one pass over recent mentions
 *   npm run agent:listen -- --watch         # keep polling
 *   npm run agent:listen -- --question="how many pools quote NVDA"
 */
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n: string): boolean => process.argv.includes(`--${n}`);

const channels = (process.env.AGENT_CHANNELS ?? 'farcaster')
  .split(',').map((s) => s.trim()).filter(Boolean);

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

  let queued = 0;
  for (const m of fresh) {
    const { signal, answered } = await signalForMention(m);

    // An unanswerable mention is not queued. Replying "I don't know" to every
    // passing mention would make the account noise, and the queue is for
    // things a person might actually want to send.
    if (!answered) {
      console.log(`SKIP  @${m.author}: not a question this agent can answer`);
      continue;
    }

    const a = await answerQuestion(m.text);
    const verification = verifyDraft(a.text, signal.facts);
    if (!verification.ok) {
      console.error(
        `SKIP  @${m.author}: answer failed verification ` +
          `(unsupported: ${verification.unsupported.join(', ') || 'none'})`,
      );
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

    queued++;
    console.log(`QUEUE ${post.id}  reply to @${m.author}  [${a.intent.kind}]`);
    console.log(`      Q: ${m.text.slice(0, 120)}`);
    console.log(`      A: ${a.text}`);
    console.log(`      reproduce: ${a.reproduce}\n`);
  }
  return queued;
}

const first = await pass();
console.log(
  `${first} repl${first === 1 ? 'y' : 'ies'} queued as drafts. Nothing is sent until approved:\n` +
    '  npm run agent:queue\n  npm run agent:approve -- <id>\n  npm run agent:publish -- --live',
);

if (flag('watch')) {
  console.log(`\nwatching for mentions every ${intervalMs / 1000}s -- ctrl-c to stop`);
  setInterval(() => {
    void pass().then((n) => {
      if (n > 0) console.log(`${n} new repl${n === 1 ? 'y' : 'ies'} queued for approval`);
    });
  }, intervalMs);
}
