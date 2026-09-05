import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDb } from '../db/index.js';
import { bankr } from '../../config/bankr.js';
import { agentIdentity } from '../../config/agent.js';
import { aboutFacts } from '../answer/conversational.js';
import { computeCoverage } from '../registry/coverage.js';
import {
  bestSampledPool, driftBySession, historyDepth, snapshotsForPool,
} from '../history/series.js';
import { largeSwapsFor, largestSwaps } from '../volume/largeSwaps.js';
import { upcomingActions } from '../corporate/calendar.js';
import { buildVolumeReport } from '../volume/usd.js';
import { listPosts } from '../agent/queue.js';
import { launches, portfolio, walletMe } from '../bankr/client.js';

/**
 * Vates, in the operator's own words, with the service's own data behind it.
 *
 * The panel already had a chat box, but it was a pass-through to Bankr's
 * agent: a different agent, on someone else's server, that knows nothing about
 * this service and — with a wallet-scoped key — *executes* rather than
 * answers. Useful for Bankr questions, useless for "why did v4 stop producing
 * measurable rows", and the wrong thing to type an open question into.
 *
 * This is the other half. Same identity as the public account, the operator's
 * data underneath it, and no ability to act.
 *
 * WHAT IS DIFFERENT FROM THE PUBLIC PATH, said plainly because it is a real
 * relaxation and not an oversight:
 *
 *   The public `/ask` model may only repeat numbers from a fixed snapshot, and
 *   `verifyDraft` discards a reply that invents one. That rule exists because
 *   a public answer is a published claim. This is not published — it is one
 *   authenticated operator asking about their own service — so the model is
 *   allowed to reason out loud, compare figures and say what it thinks
 *   something means. Nothing said here reaches a timeline. Anything that
 *   should be published still goes through compose, where verifyDraft runs
 *   exactly as before.
 *
 *   What is NOT relaxed: every number still comes from a tool call against the
 *   live database or Bankr, never from the model's memory. The tools are the
 *   only door to data, and the system prompt makes citing an uncalled number a
 *   failure rather than a style choice.
 *
 * WHAT IT CANNOT DO. Every tool here reads. Bankr's writing surfaces --
 * `deployToken`, `claimFees`, and Bankr's own `agentPrompt`, which executes
 * with this key -- are deliberately absent. The wallet is visible and
 * untouchable, which is the same shape as the rest of the project: the agent
 * has a wallet of its own and nothing here spends from it.
 */

/** How many times the model may call tools before it has to answer. */
const MAX_STEPS = 8;

/** Per-result cap. A tool that returns half the database helps nobody. */
const MAX_RESULT_CHARS = 12_000;

/**
 * Documents the model may read, by name rather than by path.
 *
 * A tool that takes a path is a file-read primitive on the box, and the panel
 * is on the internet. An allowlist keeps it to what is already public or
 * already the operator's, and makes the answer to "can this read .env" a flat
 * no rather than an argument about traversal.
 */
const DOCS: Record<string, string> = {
  readme: 'README.md',
  claude: 'CLAUDE.md',
  deploy: 'docs/DEPLOY.md',
};

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

const SYSTEM_PROMPT = `You are ${agentIdentity.name}, the agent behind the ${agentIdentity.service}
— a service that indexes every Uniswap v4 and v3 pool on Robinhood Chain (chain 4663) where one
side is a tokenized stock or ETF.

You are talking to the operator of this service in their private admin panel. This is not a
public timeline. You may think out loud, weigh possibilities, say what a figure might mean, and
disagree with the operator when the data does not support what they are assuming.

How you get facts:
- Every number you state must come from a tool call you made in THIS conversation. You have no
  reliable memory of this service's figures; what you remember is likely stale.
- If you have not called a tool for something, say you have not looked yet, then look.
- If a tool returns nothing, that is an answer: say the data is absent and what would produce
  it. Never fill a gap with a plausible number.

How you reason:
- Distinguish what is measured from what you are inferring. Say which is which.
- A null is not a zero. deviation: null means a deviation was unknowable — no Chainlink feed for
  the stock, or no USD reference for the paired token — never that it was zero.
- A flagged price (price_flag) describes one order large relative to pool depth, not a market.
  It is excluded from published statistics on purpose.
- When you are uncertain, say so and name what would settle it.

What you cannot do:
- You cannot trade, deploy, claim fees, send transactions, or spend from the wallet. Your Bankr
  tools read only. If asked to act, say plainly that this chat cannot and name the panel control
  that can.
- You cannot publish. If something here is worth posting, say so and point at the compose form,
  where a post is checked against recorded facts before it can be queued.

Be direct and concrete. Skip preamble. The operator knows the system.`;

/** The tools, in Anthropic's schema. */
export const TOOLS = [
  {
    name: 'service_overview',
    description:
      'Pool counts, stock token counts, Chainlink feed coverage, and how much price history ' +
      'has been recorded. Start here when asked what the service currently holds.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'coverage',
    description:
      'Which stock tokens have a Chainlink feed and which do not. A stock with no feed can ' +
      'never produce a deviation figure.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'drift_history',
    description:
      'The recorded price series for one stock: its busiest sampled pool, the per-session drift ' +
      'against Chainlink (regular vs closed market), and recent snapshots with their price flags ' +
      'and deviation reasons. This is the data nobody else has, because the public RPC has no archive.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Stock ticker, e.g. NVDA' },
        hours: { type: 'number', description: 'Window in hours, default 168 (7 days)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'volume_split',
    description:
      'Measured 24h stock-paired swap volume, split by protocol and by pool, priced in USD. ' +
      'Reads Chainlink for each symbol, so it takes a moment.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'largest_trades',
    description: 'The largest recorded swaps, optionally for one stock.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbol: { type: 'string', description: 'Optional stock ticker to filter by' },
        limit: { type: 'number', description: 'How many, default 10' },
      },
      required: [],
    },
  },
  {
    name: 'corporate_actions',
    description:
      'Upcoming corporate actions (dividends, splits, ticker changes) joined to the indexed pool ' +
      'set, so each carries how many pools it reprices.',
    input_schema: {
      type: 'object' as const,
      properties: { withinDays: { type: 'number', description: 'Horizon in days, default 30' } },
      required: [],
    },
  },
  {
    name: 'signals_and_queue',
    description:
      'Signals the scanner has recorded and the current post queue with each post’s status. ' +
      'Use when asked what is publishable or what is waiting for approval.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'bankr_wallet',
    description:
      'The agent’s own Bankr wallet: address and portfolio. Read only — this cannot move funds.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'bankr_launches',
    description: 'Token launches recorded against this Bankr account. Read only.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'project_doc',
    description:
      'Read one of the project’s own documents to answer questions about intent, rules and ' +
      'recorded measurements: "readme", "claude" (the project rules) or "deploy".',
    input_schema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'readme | claude | deploy' } },
      required: ['name'],
    },
  },
] as const;

/** Recent signals, straight from the table the scanner writes. */
function recentSignals(limit = 15): unknown {
  return getDb()
    .prepare(
      `SELECT id, kind, severity, summary, reproduce, detected_at
       FROM signals ORDER BY detected_at DESC LIMIT ?`,
    )
    .all(limit);
}

export async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'service_overview':
      return { ...aboutFacts(), history: historyDepth() };

    case 'coverage': {
      const c = computeCoverage();
      return { total: c.total, withFeed: c.covered, withoutFeed: c.uncovered };
    }

    case 'drift_history': {
      const symbol = String(input.symbol ?? '').trim().toUpperCase();
      if (!symbol) return { error: 'symbol is required' };
      const hours = Number(input.hours) > 0 ? Number(input.hours) : 168;
      const since = Date.now() - hours * 3_600_000;
      const best = bestSampledPool(symbol);
      if (!best) {
        return {
          symbol, hours, samples: 0,
          note: 'nothing sampled for this symbol yet; sampling covers the busiest measurable pools first',
          depth: historyDepth(),
        };
      }
      const snaps = snapshotsForPool(best.poolKey, since);
      return {
        symbol, hours, pool: best.poolKey, samples: snaps.length,
        driftBySession: driftBySession(symbol, since),
        // The tail rather than everything: the shape of the recent series is
        // what a question is usually about, and 500 rows would crowd out the
        // rest of the conversation.
        recentSnapshots: snaps.slice(-20),
        depth: historyDepth(),
      };
    }

    case 'volume_split': {
      const rep = await buildVolumeReport();
      const by = { v4: { usd: 0, swaps: 0, pools: 0 }, v3: { usd: 0, swaps: 0, pools: 0 } };
      for (const p of rep.pools) {
        const b = by[p.protocol];
        b.usd += p.volumeUsd ?? 0;
        b.swaps += p.swaps;
        b.pools += 1;
      }
      return {
        hours: rep.hours, fromBlock: rep.fromBlock, toBlock: rep.toBlock,
        totalUsd: rep.totalUsd, pricedPools: rep.pricedPools, unpricedPools: rep.unpricedPools,
        totalSwaps: rep.totalSwaps, unpricedSwaps: rep.unpricedSwaps,
        byProtocol: by,
        topPools: rep.pools.slice(0, 15),
        note: 'USD totals exclude unpriced pools; swap counts include them. Say which you mean.',
      };
    }

    case 'largest_trades': {
      const limit = Number(input.limit) > 0 ? Math.min(Number(input.limit), 50) : 10;
      const symbol = String(input.symbol ?? '').trim().toUpperCase();
      return symbol ? largeSwapsFor(symbol, limit) : largestSwaps(limit);
    }

    case 'corporate_actions': {
      const days = Number(input.withinDays) > 0 ? Number(input.withinDays) : 30;
      return { withinDays: days, actions: upcomingActions(days) };
    }

    case 'signals_and_queue':
      return {
        signals: recentSignals(),
        drafts: listPosts('draft'),
        approved: listPosts('approved'),
      };

    case 'bankr_wallet': {
      const me = await walletMe();
      try {
        return { wallet: me, portfolio: await portfolio() };
      } catch (err) {
        return { wallet: me, portfolioError: (err as Error).message };
      }
    }

    case 'bankr_launches':
      return await launches();

    case 'project_doc': {
      const key = String(input.name ?? '').trim().toLowerCase();
      const file = DOCS[key];
      if (!file) return { error: `unknown document; pick one of ${Object.keys(DOCS).join(', ')}` };
      try {
        return { name: key, file, content: readFileSync(resolve(process.cwd(), file), 'utf8') };
      } catch (err) {
        return { error: `could not read ${file}: ${(err as Error).message}` };
      }
    }

    default:
      return { error: `no tool named ${name}` };
  }
}

interface GatewayBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface GatewayReply {
  content?: GatewayBlock[];
  stop_reason?: string;
}

async function callGateway(messages: ChatMessage[]): Promise<GatewayReply> {
  const res = await fetch(`${bankr.llmBaseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': bankr.llmKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: bankr.llmModel,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok) {
    throw new Error(`llm gateway ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as GatewayReply;
}

export interface ChatTurn {
  /** The assistant's text, concatenated across blocks. */
  text: string;
  /** Which tools ran, in order, so the operator can see where a figure came from. */
  toolsUsed: string[];
  /** The full message list, to hand back on the next turn. */
  messages: ChatMessage[];
  /** True when the step budget ran out before the model stopped calling tools. */
  truncated: boolean;
}

/**
 * One turn: call, run whatever tools were asked for, call again, until the
 * model answers or the step budget runs out.
 *
 * The budget is not a performance guard. A model that keeps calling tools is
 * usually one that cannot find what it was asked for, and an unbounded loop
 * turns that into a bill; stopping and saying so is the honest outcome.
 */
export async function chatTurn(history: ChatMessage[], message: string): Promise<ChatTurn> {
  const messages: ChatMessage[] = [...history, { role: 'user', content: message }];
  const toolsUsed: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await callGateway(messages);
    const blocks = reply.content ?? [];
    messages.push({ role: 'assistant', content: blocks });

    const calls = blocks.filter((b) => b.type === 'tool_use');
    if (calls.length === 0) {
      return {
        text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n').trim(),
        toolsUsed,
        messages,
        truncated: false,
      };
    }

    const results = [];
    for (const call of calls) {
      toolsUsed.push(call.name ?? '?');
      let content: string;
      try {
        const out = await runTool(call.name ?? '', call.input ?? {});
        content = JSON.stringify(out);
        if (content.length > MAX_RESULT_CHARS) {
          content = content.slice(0, MAX_RESULT_CHARS) +
            `\n… truncated at ${MAX_RESULT_CHARS} characters; narrow the question`;
        }
      } catch (err) {
        // Handed back as a result rather than thrown: a failing tool is
        // something the model should tell the operator about, not a 500 that
        // loses the whole conversation.
        content = JSON.stringify({ error: (err as Error).message });
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    text:
      `I ran ${toolsUsed.length} tool calls without reaching an answer. ` +
      `Ask something narrower, or name the tool you want me to use.`,
    toolsUsed,
    messages,
    truncated: true,
  };
}
