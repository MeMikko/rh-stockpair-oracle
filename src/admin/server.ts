import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  adminConfig,
  adminConfigured,
  adminSignInMessage,
  isOwner,
  issueAdminNonce,
  readAdminSession,
  verifyAdminSignIn,
} from './auth.js';
import { adminPage } from './page.js';
import { adminKeyConfigured, bankr } from '../../config/bankr.js';
import {
  BankrError,
  agentJob,
  agentPrompt,
  claimFees,
  deployToken,
  launches,
  portfolio,
  probeSigning,
  tokenFees,
  walletMe,
  type DeployRequest,
} from '../bankr/client.js';
import { decide, enqueue, getPost, listPosts } from '../agent/queue.js';
import { fetchLlmSpend } from '../llm/spend.js';
import { publishPost } from '../agent/publish/index.js';
import { MAX_POST_LENGTH, verifyDraft } from '../agent/verify.js';
import { loadSignal, saveSignals, type Signal } from '../agent/signals.js';
import {
  fetchMentions,
  neynarConfigured,
  questionFromCast,
  saveMentionSignal,
  signalForMention,
  unanswered,
  type Mention,
} from '../agent/mentions.js';
import { aboutFacts } from '../answer/conversational.js';
import { answerQuestion } from '../answer/answer.js';
import { tierForFid } from '../entitlements/index.js';
import { getDb } from '../db/index.js';

/**
 * The operator panel.
 *
 * A separate process from the public API on purpose. The wallet-scoped Bankr
 * key lives here and nowhere else, so the thing that can move funds is not the
 * same thing that serves the internet — no route on the public server can
 * reach it however wrong that server goes.
 *
 * It binds to loopback by default and is not published by Caddy. Reach it over
 * an SSH tunnel or Tailscale. The owner allowlist is a second gate rather than
 * the only one, because "not routable" is a property of a deployment, and
 * deployments change.
 */

const COOKIE = 'oracle_admin';

export const adminEnv = {
  port: Number(process.env.ADMIN_PORT ?? 8090),
  host: process.env.ADMIN_HOST?.trim() || '127.0.0.1',
  /**
   * Binding to anything but loopback is possible and deliberately awkward.
   * The panel is not hardened for the open internet — its whole security story
   * is that it is not reachable from it.
   */
  allowRemote: process.env.ADMIN_ALLOW_REMOTE === '1',
  /**
   * Cookies are not marked Secure by default: over an SSH tunnel the panel is
   * plain http on localhost, and a Secure cookie would simply never be sent,
   * which looks like a broken login rather than a security setting.
   */
  secureCookie: process.env.ADMIN_SECURE_COOKIE === '1',
};

function tokenFrom(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return undefined;
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : undefined;
}

/** Errors from Bankr are reported as they came, including the status. */
function sendBankrError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof BankrError) {
    return reply.code(err.status >= 400 && err.status < 600 ? err.status : 502).send({
      error: err.message,
      hint:
        err.status === 403
          ? 'The admin key is missing a capability. Enable it at bankr.bot/api-keys, or check its IP allowlist.'
          : undefined,
    });
  }
  return reply.code(500).send({ error: (err as Error).message });
}

export function buildAdminServer(): FastifyInstance {
  const configured = adminConfigured();
  if (!configured.ok) throw new Error(`admin panel is not configured: ${configured.error}`);
  if (adminEnv.host !== '127.0.0.1' && adminEnv.host !== 'localhost' && !adminEnv.allowRemote) {
    throw new Error(
      `refusing to bind the admin panel to ${adminEnv.host}. Set ADMIN_ALLOW_REMOTE=1 only if ` +
        'something else — a VPN, a firewall — is keeping it off the public internet.',
    );
  }

  const app = Fastify({ logger: true });

  app.addHook('onSend', async (_req, reply, payload) => {
    // Nothing here is cacheable and nothing here should ever be framed.
    reply.header('cache-control', 'no-store');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    return payload;
  });

  /**
   * The gate. Everything under /admin/ except sign-in requires an owner
   * session, checked here rather than in each handler so that a route added
   * later is protected by default instead of by memory.
   */
  const OPEN = new Set([
    '/admin/nonce',
    '/admin/verify',
    '/admin/logout',
    '/admin/me',
    '/admin/health',
  ]);
  app.addHook('preHandler', async (req, reply) => {
    const url = req.routeOptions?.url ?? '';
    if (!url.startsWith('/admin/') || OPEN.has(url)) return;
    const session = readAdminSession(tokenFrom(req));
    if (!session) {
      return reply.code(401).send({ error: 'sign in with an address listed in ADMIN_ADDRESSES' });
    }
    (req as unknown as { owner: string }).owner = session.subject;
  });

  const owner = (req: FastifyRequest): string => (req as unknown as { owner: string }).owner;

  /** The same channel list the scanner and the webhook queue against. */
  const channels = (): string[] =>
    (process.env.AGENT_CHANNELS ?? 'farcaster')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  /* ------------------------------------------------------------ sign-in -- */

  app.get('/', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return adminPage();
  });

  app.get('/admin/health', async () => ({
    ok: true,
    owners: adminConfig.owners.length,
    adminKey: adminKeyConfigured(),
    apiBaseUrl: bankr.apiBaseUrl,
  }));

  app.get('/admin/nonce', async (req) => {
    const raw = (req.query as { address?: string } | undefined)?.address?.trim();
    const nonce = issueAdminNonce();
    // Lowercased here because verification rebuilds the message from the
    // normalised address. Handing back a message built from a checksummed
    // address would produce a signature over text nobody ever checks against,
    // and a sign-in that fails with "signature does not match that address".
    const address = raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
    return {
      nonce,
      address,
      message: address ? adminSignInMessage(address, nonce) : null,
      expiresInSeconds: 600,
    };
  });

  app.post('/admin/verify', async (req, reply) => {
    const b = req.body as { address?: string; signature?: string; nonce?: string } | undefined;
    if (!b?.address || !b.signature || !b.nonce) {
      return reply.code(400).send({ error: 'body must be {address, signature, nonce}' });
    }
    const res = await verifyAdminSignIn(b as { address: string; signature: string; nonce: string });
    if (!res.ok) {
      req.log.warn(`admin sign-in rejected: ${res.error}`);
      return reply.code(401).send({ error: res.error });
    }
    reply.header(
      'set-cookie',
      `${COOKIE}=${res.token}; Path=/; HttpOnly; SameSite=Strict; ${
        adminEnv.secureCookie ? 'Secure; ' : ''
      }Max-Age=${12 * 3600}`,
    );
    req.log.info(`admin session issued to ${res.address}`);
    return { ok: true, address: res.address };
  });

  app.post('/admin/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  app.get('/admin/me', async (req) => {
    const session = readAdminSession(tokenFrom(req));
    return {
      signedIn: session !== null,
      address: session?.subject ?? null,
      owner: isOwner(session?.subject ?? null),
      adminKey: adminKeyConfigured(),
    };
  });

  /* -------------------------------------------------------------- reads -- */

  app.get('/admin/wallet', async (_req, reply) => {
    try {
      // Two calls, reported separately: a portfolio failure should not hide
      // the address, which is the thing an operator most often came for.
      const me = await walletMe();
      let holdings: unknown = null;
      let holdingsError: string | null = null;
      try {
        holdings = await portfolio();
      } catch (err) {
        holdingsError = (err as Error).message;
      }
      return { wallet: me, portfolio: holdings, portfolioError: holdingsError };
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  app.get('/admin/llm', async () => {
    const spend = await fetchLlmSpend(30);
    return spend ?? { error: 'no LLM key in this process' };
  });

  app.get('/admin/queue', async () => ({
    drafts: listPosts('draft'),
    approved: listPosts('approved'),
  }));

  app.get('/admin/launches', async (_req, reply) => {
    try {
      const all = await launches();
      return { launches: (all.launches ?? []).slice(0, 25) };
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  app.get('/admin/fees', async (req, reply) => {
    const token = (req.query as { token?: string } | undefined)?.token?.trim();
    if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
      return reply.code(400).send({ error: 'pass ?token=0x…' });
    }
    try {
      return await tokenFees(token);
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  app.get('/admin/scope', async () => {
    // What the key in THIS process can do, and what the public server's key
    // can do. The second is the answer to the question that started all this.
    const results: Record<string, unknown> = {};
    if (bankr.adminKey) results.adminKey = await probeSigning(bankr.adminKey);
    if (bankr.llmKey) results.llmKey = await probeSigning(bankr.llmKey);
    const llm = results.llmKey as { canSign?: boolean } | undefined;
    return {
      ...results,
      verdict: llm?.canSign
        ? 'The LLM key can sign. It is not gateway-only — rotate it at bankr.bot/api-keys.'
        : 'ok',
    };
  });

  /* ------------------------------------------------------------- writes -- */

  app.post('/admin/queue/:id/decide', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = req.body as { decision?: string } | undefined;
    if (body?.decision !== 'approved' && body?.decision !== 'rejected') {
      return reply.code(400).send({ error: 'body must be {"decision":"approved"|"rejected"}' });
    }
    try {
      const post = decide(id, body.decision, owner(req));
      return { ok: true, post };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /**
   * Launch a token.
   *
   * Three things stand between a click and an irreversible deploy: the request
   * simulates unless told otherwise, a real deploy requires the symbol typed
   * back verbatim, and the whole route sits behind the owner gate on a
   * loopback port. A simulation costs nothing — no gas, no quota slot — so
   * there is no reason for the safe path not to be the default one.
   */
  app.post('/admin/launch', async (req, reply) => {
    const b = req.body as
      | {
          tokenName?: string;
          tokenSymbol?: string;
          feeRecipient?: string;
          chain?: string;
          simulate?: boolean;
          confirm?: string;
        }
      | undefined;

    const name = b?.tokenName?.trim() ?? '';
    const symbol = b?.tokenSymbol?.trim().toUpperCase() ?? '';
    if (!name || !symbol) {
      return reply.code(400).send({ error: 'tokenName and tokenSymbol are required' });
    }
    if (!/^[A-Z0-9]{1,20}$/.test(symbol)) {
      return reply.code(400).send({ error: 'tokenSymbol must be 1-20 letters or digits' });
    }

    const simulate = b?.simulate !== false;
    if (!simulate && b?.confirm !== `LAUNCH ${symbol}`) {
      return reply.code(400).send({
        error: `a real deploy needs confirm: "LAUNCH ${symbol}"`,
        note: 'Deploys are irreversible, and each counts against 3 attempts per rolling 24 hours.',
      });
    }

    const request: DeployRequest = { tokenName: name, tokenSymbol: symbol, simulateOnly: simulate };
    if (b?.chain === 'base') request.chain = 'base';
    if (b?.feeRecipient?.trim()) {
      request.feeRecipient = { type: 'wallet', value: b.feeRecipient.trim() };
    }

    try {
      const res = await deployToken(request);
      req.log.info(
        `${simulate ? 'simulated' : 'DEPLOYED'} ${symbol} on ${request.chain ?? 'robinhood'} ` +
          `by ${owner(req)}${res.tokenAddress ? ` → ${res.tokenAddress}` : ''}`,
      );
      return { ok: true, simulated: simulate, result: res };
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  app.post('/admin/fees/claim', async (req, reply) => {
    const b = req.body as { tokenAddress?: string; confirm?: string } | undefined;
    const token = b?.tokenAddress?.trim() ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
      return reply.code(400).send({ error: 'tokenAddress must be an address' });
    }
    if (b?.confirm !== 'CLAIM') {
      return reply.code(400).send({ error: 'body must include confirm: "CLAIM"' });
    }
    try {
      const res = await claimFees(token);
      req.log.info(`fees claimed for ${token} by ${owner(req)}: ${res.transactionHash ?? 'no hash'}`);
      return { ok: true, result: res };
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  /**
   * Send an approved post.
   *
   * The last gate before a public timeline, and the only irreversible thing
   * in this panel that is not a transaction. Four things have to hold, and
   * three of them were already true before this route existed:
   *
   *   1. the post is `approved` — someone acted on it, in a separate click;
   *   2. the channel has credentials, or it is skipped rather than failed;
   *   3. `confirm: "SEND"` — without it this is a dry run, like the launch;
   *   4. the owner gate, as everywhere else here.
   *
   * The rules themselves live in publishPost, shared with agent:publish. Two
   * copies of "what may go out" is how one of them ends up wrong.
   */
  app.post('/admin/queue/:id/publish', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const post = getPost(id);
    if (!post) return reply.code(404).send({ error: 'no post with that id' });

    const live = (req.body as { confirm?: string } | undefined)?.confirm === 'SEND';
    try {
      const outcome = await publishPost(post, live);
      if (outcome.status === 'skipped') {
        req.log.warn(`publish ${id} skipped: no credentials for ${outcome.skipped.join(', ')}`);
        return {
          ...outcome,
          note: 'still approved — configure the channel and try again; nothing was sent',
        };
      }
      req.log.info(
        `${live ? 'PUBLISHED' : 'dry-run'} ${id} by ${owner(req)} -> ${outcome.results
          .map((r) => `${r.channel}:${r.error ?? r.ref ?? 'would post'}`)
          .join(', ')}`,
      );
      return outcome;
    } catch (err) {
      // assertPublishable throws for anything not approved. That is a refusal
      // to be reported, not a server fault.
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  /* ------------------------------------------------- talking to Bankr -- */

  /**
   * A sentence to Bankr's own agent.
   *
   * Not a chat with Vates — Vates has no chat; it reads signals and drafts.
   * This is the wallet's own agent, and with a read-write key it *executes*:
   * "sell all my BNKR" is a trade, not a question. Every prompt is logged
   * with the address that sent it, because a panel that can spend should
   * leave a record of who asked.
   */
  app.post('/admin/agent/prompt', async (req, reply) => {
    const b = req.body as { prompt?: string; threadId?: string } | undefined;
    const prompt = b?.prompt?.trim() ?? '';
    if (!prompt) return reply.code(400).send({ error: 'body must be {"prompt": "…"}' });
    if (prompt.length > 10_000) {
      return reply.code(400).send({ error: 'Bankr caps a prompt at 10,000 characters' });
    }
    try {
      const job = await agentPrompt(prompt, b?.threadId?.trim() || undefined);
      req.log.info(`agent prompt by ${owner(req)}: ${prompt.slice(0, 160)}`);
      return job;
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  app.get('/admin/agent/job/:jobId', async (req, reply) => {
    try {
      return await agentJob((req.params as { jobId: string }).jobId);
    } catch (err) {
      return sendBankrError(reply, err);
    }
  });

  /* ------------------------------------------------- composing a post -- */

  /** Signals the scanner has recorded, and whether each already has a post. */
  app.get('/admin/signals', async () => {
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.kind, s.severity, s.summary, s.facts_json, s.reproduce, s.detected_at,
                (SELECT p.id FROM posts p WHERE p.signal_id = s.id) AS post_id
         FROM signals s ORDER BY s.detected_at DESC LIMIT 25`,
      )
      .all() as unknown as Array<Record<string, unknown>>;
    return {
      signals: rows.map((r) => ({
        id: String(r.id),
        kind: String(r.kind),
        severity: String(r.severity),
        summary: String(r.summary),
        reproduce: String(r.reproduce),
        detectedAt: Number(r.detected_at),
        facts: JSON.parse(String(r.facts_json)) as Record<string, unknown>,
        queuedAs: r.post_id ? String(r.post_id) : null,
      })),
    };
  });

  /**
   * The facts a given draft may cite.
   *
   * Attached to a signal, that is the signal's own facts. Free-standing, it is
   * the same curated snapshot the conversational path uses — narrow on
   * purpose. An operator writing by hand is held to exactly the rule the model
   * is held to: a number that is not in the facts does not go out.
   */
  const factsFor = (signalId: string | undefined): Record<string, unknown> | null => {
    if (!signalId) return aboutFacts();
    const signal = loadSignal(signalId);
    return signal ? signal.facts : null;
  };

  app.post('/admin/compose/check', async (req, reply) => {
    const b = req.body as { signalId?: string; text?: string } | undefined;
    const facts = factsFor(b?.signalId?.trim() || undefined);
    if (!facts) return reply.code(404).send({ error: 'no signal with that id' });
    return {
      verification: verifyDraft(b?.text ?? '', facts),
      facts,
      maxLength: MAX_POST_LENGTH,
    };
  });

  app.post('/admin/compose', async (req, reply) => {
    const b = req.body as { signalId?: string; text?: string; reproduce?: string } | undefined;
    const text = b?.text?.trim() ?? '';
    if (!text) return reply.code(400).send({ error: 'nothing to queue' });

    const signalId = b?.signalId?.trim() || undefined;
    const facts = factsFor(signalId);
    if (!facts) return reply.code(404).send({ error: 'no signal with that id' });

    const verification = verifyDraft(text, facts);
    if (!verification.ok) {
      // The same two failures the webhook reports separately, for the same
      // reason: "failed verification" with an empty list explains nothing.
      return reply.code(400).send({
        error: verification.unsupported.length
          ? `numbers not in the facts: ${verification.unsupported.join(', ')}`
          : `too long for a cast: ${verification.length}/${MAX_POST_LENGTH}`,
        verification,
      });
    }

    // A hand-written post still needs a signal, because the queue keys on one
    // and because a post with no recorded basis is the thing this project does
    // not publish. Writing the basis down makes it explicit rather than
    // implicit in someone's memory.
    let id = signalId;
    if (!id) {
      const signal: Signal = {
        id: createHash('sha256').update(`operator:${text}`).digest('hex').slice(0, 16),
        kind: 'operator_note',
        severity: 'info',
        summary: `written by ${owner(req)}`,
        facts: facts as Record<string, string | number | boolean | null>,
        reproduce: b?.reproduce?.trim() || 'GET /health',
        detectedAt: Date.now(),
      };
      saveSignals([signal]);
      id = signal.id;
    }

    const post = enqueue(id, { text, draftedBy: `operator:${owner(req)}`, verification }, channels());
    if (!post) return reply.code(409).send({ error: 'that signal already has a post in the queue' });
    req.log.info(`queued a hand-written post ${post.id} by ${owner(req)}`);
    return { ok: true, post };
  });

  /* ----------------------------------------------------------- mentions -- */

  /**
   * Mentions are cached server-side between the list and the reply.
   *
   * Not for speed. The FID decides the asker's tier, and the tier decides
   * whether the model may answer at all — so taking the FID back from the
   * browser would let whoever holds the panel hand themselves a subscriber's
   * treatment. It comes from Neynar or it does not come.
   */
  const seen = new Map<string, Mention>();

  app.get('/admin/mentions', async (_req, reply) => {
    const fid = process.env.NEYNAR_AGENT_FID?.trim();
    if (!neynarConfigured() || !fid) {
      return reply
        .code(503)
        .send({ error: 'NEYNAR_API_KEY and NEYNAR_AGENT_FID are needed to read mentions' });
    }
    try {
      const all = await fetchMentions(fid);
      seen.clear();
      for (const m of all) seen.set(m.hash, m);
      return {
        pending: unanswered(all).map((m) => ({
          hash: m.hash,
          author: m.author,
          text: m.text,
          question: questionFromCast(m.text),
          timestamp: m.timestamp,
        })),
        total: all.length,
      };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  /**
   * Answer one mention and put the reply in the queue.
   *
   * The same path the webhook takes, minus the autonomous branch: from here a
   * reply is always queued, because a person is already sitting in front of it.
   */
  app.post('/admin/mentions/:hash/queue', async (req, reply) => {
    const hash = (req.params as { hash: string }).hash;
    const mention = seen.get(hash);
    if (!mention) return reply.code(404).send({ error: 'reload the mention list first' });

    const { signal, answered, conversational } = await signalForMention(mention);
    if (!answered && !conversational) {
      return { queued: false, reason: 'the classifier could not route this; saying nothing' };
    }

    const tier = mention.authorFid ? tierForFid(mention.authorFid).tier : 'free';
    const a = await answerQuestion(questionFromCast(mention.text), new Date(), { tier });
    const verification = verifyDraft(a.text, signal.facts);
    if (!verification.ok) {
      return {
        queued: false,
        reason: verification.unsupported.length
          ? `the answer cited numbers not in its facts: ${verification.unsupported.join(', ')}`
          : `the answer is too long for a cast: ${verification.length}/${MAX_POST_LENGTH}`,
        text: a.text,
      };
    }

    saveMentionSignal(signal);
    const post = enqueue(
      signal.id,
      { text: a.text, draftedBy: 'answer', verification },
      channels(),
      mention.hash,
    );
    req.log.info(`queued a reply to @${mention.author} by ${owner(req)}`);
    return {
      queued: Boolean(post),
      reason: post ? undefined : 'already queued',
      post,
      text: a.text,
      reproduce: a.reproduce,
    };
  });

  return app;
}
