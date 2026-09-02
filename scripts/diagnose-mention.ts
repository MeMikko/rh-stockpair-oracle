import { tierForFid } from '../src/entitlements/index.js';
import { conversationalAnswer, conversationalConfig } from '../src/answer/conversational.js';
import { questionFromCast } from '../src/agent/mentions.js';
import { answerQuestion } from '../src/answer/answer.js';
import { autonomyConfig, decide } from '../src/agent/autonomy.js';

/**
 * Trace one mention through every gate, without sending anything.
 *
 * A mention that goes unanswered has half a dozen possible causes -- wrong
 * tier, model off, missing key, a rejected reply, an autonomy gate -- and the
 * log line only reports the last one reached. This walks all of them in order
 * and prints where it stops.
 *
 *   npm run diagnose -- --fid=1522563 --cast="@vates introduce yourself"
 */
const arg = (n: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const fid = arg('fid') ?? process.env.NEYNAR_AGENT_FID ?? '';
const cast = arg('cast') ?? '@vates introduce yourself';

console.log(`cast : ${JSON.stringify(cast)}`);
console.log(`fid  : ${fid || '(none given)'}\n`);

const tier = fid ? tierForFid(fid) : null;
console.log(`1. tier          ${tier ? `${tier.tier} — ${tier.reason}` : 'no fid'}`);
console.log(
  `2. llm           mode=${conversationalConfig.mode} ` +
    `key=${conversationalConfig.apiKey ? 'set' : 'MISSING'} model=${conversationalConfig.model}`,
);

const question = questionFromCast(cast);
console.log(`3. question      ${JSON.stringify(question)}`);

const direct = await conversationalAnswer(question, '<<fallback>>');
console.log(
  `4. model call    usedModel=${direct.usedModel}` +
    (direct.rejected ? ` rejected=[${direct.rejected.join(', ') || 'no reason'}]` : ''),
);
if (direct.usedModel) console.log(`                 ${direct.text.slice(0, 140)}`);

const answer = await answerQuestion(question, new Date(), { tier: tier?.tier ?? 'free' });
const worthSaying = answer.answered || Boolean(answer.conversational);
console.log(
  `5. full answer   intent=${answer.intent.kind} answered=${answer.answered} ` +
    `conversational=${Boolean(answer.conversational)}`,
);
console.log(`                 ${answer.text.slice(0, 140)}`);

const verdict = decide({ fid: fid || null, answered: worthSaying });
console.log(`6. autonomy      mode=${autonomyConfig.mode} → ${verdict.autonomous ? 'SEND' : 'no'}`);
console.log(`                 ${verdict.reason}`);

console.log(
  `\nresult: ${
    !worthSaying
      ? 'silent — nothing worth saying (see step 4 or 5)'
      : verdict.autonomous
        ? 'would reply directly on Farcaster'
        : 'would queue for approval (see step 6)'
  }`,
);
