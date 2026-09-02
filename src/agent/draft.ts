import type { Signal } from './signals.js';
import { verifyDraft, MAX_POST_LENGTH, type VerificationResult } from './verify.js';

export interface Draft {
  text: string;
  draftedBy: string;          // llm:<model> | template
  verification: VerificationResult;
  llmRejected?: { text: string; unsupported: string[] } | undefined;
}

export const agentEnv = {
  llmBaseUrl: process.env.BANKR_LLM_BASE_URL ?? 'https://llm.bankr.bot',
  llmApiKey: process.env.BANKR_LLM_API_KEY ?? '',
  llmModel: process.env.BANKR_LLM_MODEL ?? 'claude-sonnet-5',
};

/**
 * Deterministic phrasing. Always available, never wrong, and the fallback
 * whenever the model's draft fails verification -- so a missing API key or a
 * hallucinated number degrades to a plainer post rather than to no post or,
 * worse, an unsupported one.
 */
export function templateDraft(signal: Signal): string {
  const f = signal.facts;
  switch (signal.kind) {
    case 'corporate_action': {
      const kind = String(f.actionType).toLowerCase().replace(/_/g, ' ');
      const rate = f.rate ? ` (rate ${f.rate})` : '';
      return `${f.symbol}: ${kind}${rate} processes ${f.processDate}. ` +
             `On Robinhood Chain this lands as an ERC-8056 multiplier change, repricing ` +
             `${f.affectedPools} indexed pool(s) quoted in ${f.symbol}.`;
    }
    case 'oracle_coverage':
      return `${f.uncovered} of ${f.total} Robinhood Chain stock tokens have no Chainlink feed ` +
             `(${f.coveragePercent}% covered). For those, a pool's deviation from the underlying ` +
             `price is not just unknown, it is unknowable on-chain.`;
    case 'protocol_split':
      // Every number here appears verbatim in the signal's facts; nothing is
      // derived at drafting time, so the verifier passes the template. The
      // claim rests on the share alone -- deliberately not on which protocol
      // holds the single biggest pool, since ranking by USD and by swap count
      // pick different pools.
      return `Uniswap v3 carries ${f.v3SharePercent}% of stock-paired swap volume on ` +
             `Robinhood Chain: $${f.v3VolumeUsdMillions}M of $${f.totalVolumeUsdMillions}M ` +
             `over ${f.windowHours}h. An index that covers only v4 misses all of it.`;
    case 'gas_subsidy':
      return `Robinhood Chain is charging for L1 data in ${f.nonZeroSamples} of the last ` +
             `${f.samples} samples. The launch gas subsidy appears to be ending.`;
    default:
      return signal.summary;
  }
}

const SYSTEM_PROMPT = `You write short factual posts for a data feed about Robinhood Chain.

Absolute rules:
- Use ONLY numbers that appear in the FACTS given to you. Never compute, derive,
  round, or estimate a new number. No percentages or ratios unless present.
- No hype, no emoji, no hashtags, no price predictions, no financial advice.
- No calls to action, no promotion, no "check out".
- One or two sentences. Under ${MAX_POST_LENGTH} characters.
- Plain declarative statements of what the data shows.

Return only the post text.`;

async function callGateway(signal: Signal): Promise<string> {
  const res = await fetch(`${agentEnv.llmBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': agentEnv.llmApiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: agentEnv.llmModel,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `SIGNAL: ${signal.kind}\nSUMMARY: ${signal.summary}\n` +
                 `FACTS:\n${JSON.stringify(signal.facts, null, 2)}\n\n` +
                 `Write the post.`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`llm gateway ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
  if (!text) throw new Error('llm gateway returned no text');
  return text;
}

/**
 * Draft a post for a signal.
 *
 * The model only ever phrases an observation the deterministic layer already
 * made, and its output must pass verification against that signal's facts. If
 * it does not, the model's text is discarded (and reported, so the failure is
 * visible) and the template is used instead.
 */
export async function draftPost(signal: Signal): Promise<Draft> {
  if (agentEnv.llmApiKey) {
    try {
      const text = await callGateway(signal);
      const verification = verifyDraft(text, signal.facts);
      if (verification.ok) {
        return { text, draftedBy: `llm:${agentEnv.llmModel}`, verification };
      }
      const fallback = templateDraft(signal);
      return {
        text: fallback,
        draftedBy: 'template',
        verification: verifyDraft(fallback, signal.facts),
        llmRejected: { text, unsupported: verification.unsupported },
      };
    } catch (err) {
      console.warn(`[draft] gateway failed, using template: ${(err as Error).message}`);
    }
  }

  const text = templateDraft(signal);
  return { text, draftedBy: 'template', verification: verifyDraft(text, signal.facts) };
}
