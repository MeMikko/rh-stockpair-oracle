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
  claimFees,
  deployToken,
  launches,
  portfolio,
  probeSigning,
  tokenFees,
  walletMe,
  type DeployRequest,
} from '../bankr/client.js';
import { decide, listPosts } from '../agent/queue.js';
import { fetchLlmSpend } from '../llm/spend.js';

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

  return app;
}
