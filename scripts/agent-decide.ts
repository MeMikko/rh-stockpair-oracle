import { decide } from '../src/agent/queue.js';
import { userInfo } from 'node:os';

const [, , decisionArg, ...rest] = process.argv;
const ids = rest.filter(a => !a.startsWith('--'));
const decision = decisionArg === 'approve' ? 'approved' : decisionArg === 'reject' ? 'rejected' : null;

if (!decision || ids.length === 0) {
  console.error('usage: tsx scripts/agent-decide.ts <approve|reject> <postId...>');
  process.exit(2);
}

// Recorded so the queue shows who authorised a public post.
const by = process.env.AGENT_APPROVER ?? userInfo().username ?? 'unknown';
for (const id of ids) {
  try {
    const p = decide(id, decision, by);
    console.log(`${p.id} -> ${p.status} (by ${by})`);
  } catch (err) {
    console.error(`${id}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
