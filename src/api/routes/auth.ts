import type { FastifyInstance } from 'fastify';
import {
  authConfigured, issueNonce, signInMessage, tierForSession, verifySignIn,
} from '../../auth/session.js';

/**
 * Wallet sign-in.
 *
 * Exists because the entitlements module refuses to honour a claimed identity:
 * without proof, every HTTP caller is free no matter what it sends. A wallet
 * signature is that proof, and it is self-contained -- no third party to be
 * down, and nothing to configure beyond a signing secret.
 *
 * The session rides in an HttpOnly cookie so page JavaScript cannot read it,
 * and is also returned in the body for non-browser callers, which have no
 * cookie jar and no XSS to protect against.
 */
const COOKIE = 'oracle_session';

function setSessionCookie(reply: { header: (k: string, v: string) => void }, token: string): void {
  reply.header(
    'set-cookie',
    // Lax rather than Strict: a link into the dashboard from Farcaster should
    // still arrive signed in. Secure, because this is only ever served
    // over TLS.
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${7 * 24 * 3600}`,
  );
}

function tokenFrom(req: { headers: Record<string, unknown> }): string | undefined {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.cookie;
  if (typeof cookie !== 'string') return undefined;
  const m = cookie.match(new RegExp(`(?:^|;\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : undefined;
}

export function registerAuth(app: FastifyInstance): void {
  app.get('/auth/nonce', async (req, reply) => {
    if (!authConfigured()) return reply.code(503).send({ error: 'sign-in not configured' });
    const raw = (req.query as { address?: string } | undefined)?.address?.trim();
    const nonce = issueNonce();
    // Lowercased, because verification rebuilds the message from the
    // normalised address. A caller passing a checksummed address used to get
    // back a message whose signature could never verify -- browser wallets
    // hand out lowercase, so it only bit callers that typed the address.
    const address = raw && /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw.toLowerCase() : null;
    return {
      nonce,
      address,
      // The exact bytes to sign, so a caller never has to reconstruct the
      // message and get a byte wrong.
      message: address ? signInMessage(address, nonce) : null,
      expiresInSeconds: 600,
    };
  });

  app.post('/auth/verify', async (req, reply) => {
    const b = req.body as { address?: string; signature?: string; nonce?: string } | undefined;
    if (!b?.address || !b.signature || !b.nonce) {
      return reply.code(400).send({ error: 'body must be {address, signature, nonce}' });
    }
    const res = await verifySignIn({ address: b.address, signature: b.signature, nonce: b.nonce });
    if (!res.ok) {
      req.log.warn(`sign-in rejected: ${res.error}`);
      return reply.code(401).send({ error: res.error });
    }
    setSessionCookie(reply, res.token);
    const t = tierForSession(res.token);
    return { ok: true, token: res.token, address: t.subject, tier: t.tier, reason: t.reason };
  });

  app.get('/auth/me', async (req) => {
    const t = tierForSession(tokenFrom(req as never));
    return { address: t.subject, tier: t.tier, reason: t.reason, signedIn: t.subject !== null };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return { ok: true };
  });
}

export { tokenFrom };
