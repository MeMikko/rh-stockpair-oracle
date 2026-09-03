import { tolerateClosedPipe } from '../src/util/stdout.js';
import { fetchCorporateActions, saveCorporateActions } from '../src/corporate/calendar.js';
import { detectClosedMarketDrift, detectCorporateActions, detectCoverage, detectGasSubsidy, detectIntroduction, detectProtocolSplit, saveSignals, type Signal } from '../src/agent/signals.js';
import { draftPost } from '../src/agent/draft.js';
import { enqueue } from '../src/agent/queue.js';

tolerateClosedPipe();

const channels = (process.env.AGENT_CHANNELS ?? 'farcaster').split(',').map(s => s.trim()).filter(Boolean);

const actions = await fetchCorporateActions();
saveCorporateActions(actions);
console.log(`corporate actions synced: ${actions.length}`);

const signals: Signal[] = [
  ...detectCorporateActions(),
  ...detectIntroduction(),
  ...detectCoverage(),
  ...(await detectProtocolSplit()),
  ...(await detectGasSubsidy()),
  // Says nothing until the record is long enough to support it.
  ...detectClosedMarketDrift(),
];
const { inserted } = saveSignals(signals);
console.log(`signals: ${signals.length} detected, ${inserted} new\n`);

let queued = 0;
for (const s of signals) {
  const draft = await draftPost(s);
  if (!draft.verification.ok) {
    console.log(`SKIP  ${s.kind} ${s.id}: draft failed verification ` +
                `(unsupported: ${draft.verification.unsupported.join(', ') || 'none'}, len ${draft.verification.length})`);
    continue;
  }
  const post = enqueue(s.id, draft, channels);
  if (!post) continue;
  queued++;
  console.log(`QUEUE ${post.id}  [${s.severity}] ${s.kind}  via ${draft.draftedBy}`);
  console.log(`      ${draft.text}`);
  if (draft.llmRejected) {
    console.log(`      note: model draft discarded, unsupported numbers: ${draft.llmRejected.unsupported.join(', ')}`);
  }
  console.log(`      reproduce: ${s.reproduce}\n`);
}
console.log(`${queued} post(s) queued as drafts. Nothing is published until approved:`);
console.log('  npm run agent:queue                 # review');
console.log('  npm run agent:approve -- <id>       # approve one');
console.log('  npm run agent:publish               # dry run; add -- --live to actually post');
