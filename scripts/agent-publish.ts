import { listPosts, markPosted, markFailed } from '../src/agent/queue.js';
import { assertPublishable } from '../src/agent/publish/index.js';
import { farcaster } from '../src/agent/publish/farcaster.js';
import { x } from '../src/agent/publish/x.js';

const live = process.argv.includes('--live');
const publishers = { farcaster, x } as const;

const approved = listPosts('approved');
if (approved.length === 0) {
  console.log('nothing approved to publish');
  process.exit(0);
}

if (!live) console.log('DRY RUN -- nothing will be sent. Add --live to publish for real.\n');

for (const post of approved) {
  assertPublishable(post); // belt and braces: only 'approved' reaches a channel

  // An unconfigured channel is not a failed post. Skipping leaves it approved
  // so it can go out once credentials exist, rather than burning a post that
  // a person already signed off on.
  const unconfigured = live
    ? post.channels.filter((ch) => {
        const p = publishers[ch as keyof typeof publishers];
        return !p || !p.configured();
      })
    : [];

  if (live && unconfigured.length > 0) {
    console.log(`${post.id} SKIPPED -- no credentials for: ${unconfigured.join(', ')}`);
    console.log(`   still approved; configure the channel and re-run\n`);
    continue;
  }

  const results = [];
  for (const ch of post.channels) {
    const pub = publishers[ch as keyof typeof publishers];
    if (!pub) { results.push({ channel: ch, ref: null, dryRun: true, error: 'unknown channel' }); continue; }
    results.push(await pub.publish(post.draftText, !live, post.replyTo));
  }

  const kind = post.replyTo ? `reply to ${post.replyTo.slice(0, 12)}…` : 'broadcast';
  console.log(`${post.id} [${live ? 'LIVE' : 'dry-run'}] ${kind} -> ${post.channels.join(',')}`);
  console.log(`   ${post.draftText}`);
  for (const r of results) {
    console.log(`   ${r.channel}: ${r.error ? 'ERROR ' + r.error : r.dryRun ? 'would post' : 'posted ' + r.ref}`);
  }
  console.log();

  if (!live) continue;
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) markFailed(post.id, errors.map((e) => `${e.channel}: ${e.error}`).join('; '));
  else markPosted(post.id, results.map((r) => `${r.channel}:${r.ref}`).join(','));
}
