import { listPosts } from '../src/agent/queue.js';
import { publishPost } from '../src/agent/publish/index.js';

/**
 * Send everything a person has approved.
 *
 * The rules about what may go out live in publishPost, shared with the
 * operator panel: approved only, credentials present, --live asked for
 * explicitly. This file is the terminal in front of them.
 *
 *   npm run agent:publish            # dry run: prints what would be sent
 *   npm run agent:publish -- --live  # sends
 */

const live = process.argv.includes('--live');

const approved = listPosts('approved');
if (approved.length === 0) {
  console.log('nothing approved to publish');
  process.exit(0);
}

if (!live) console.log('DRY RUN -- nothing will be sent. Add --live to publish for real.\n');

for (const post of approved) {
  const outcome = await publishPost(post, live);

  if (outcome.status === 'skipped') {
    console.log(`${post.id} SKIPPED -- no credentials for: ${outcome.skipped.join(', ')}`);
    console.log('   still approved; configure the channel and re-run\n');
    continue;
  }

  const kind = post.replyTo ? `reply to ${post.replyTo.slice(0, 12)}…` : 'broadcast';
  console.log(`${post.id} [${live ? 'LIVE' : 'dry-run'}] ${kind} -> ${post.channels.join(',')}`);
  console.log(`   ${post.draftText}`);
  for (const r of outcome.results) {
    console.log(
      `   ${r.channel}: ${r.error ? 'ERROR ' + r.error : r.dryRun ? 'would post' : 'posted ' + r.ref}`,
    );
  }
  console.log();
}
