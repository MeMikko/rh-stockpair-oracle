import { tolerateClosedPipe } from '../src/util/stdout.js';
import { listPosts } from '../src/agent/queue.js';
import { loadSignal } from '../src/agent/signals.js';

tolerateClosedPipe();

const filter = process.argv.find(a => a.startsWith('--status='))?.split('=')[1];
const posts = listPosts(filter as never);

if (posts.length === 0) {
  console.log(filter ? `no posts with status '${filter}'` : 'queue is empty');
} else {
  for (const p of posts) {
    const s = loadSignal(p.signalId);
    console.log(`${p.id}  ${p.status.toUpperCase().padEnd(8)} ${s?.kind ?? '?'}  [${s?.severity ?? '?'}]  via ${p.draftedBy}  -> ${p.channels.join(',')}`);
    console.log(`   ${p.draftText}`);
    console.log(`   reproduce: ${s?.reproduce ?? 'n/a'}`);
    if (p.decidedBy) console.log(`   decided by ${p.decidedBy} at ${new Date(p.decidedAt!).toISOString()}`);
    if (p.postRefs) console.log(`   refs: ${p.postRefs}`);
    if (p.error) console.log(`   error: ${p.error}`);
    console.log();
  }
  const counts = posts.reduce<Record<string, number>>((m, p) => (m[p.status] = (m[p.status] ?? 0) + 1, m), {});
  console.log(Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
}
