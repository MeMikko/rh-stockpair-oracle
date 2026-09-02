import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { answerQuestion } from '../../answer/answer.js';
import { verifyDraft } from '../../agent/verify.js';
import { enqueue } from '../../agent/queue.js';
import { saveMentionSignal, signalForMention, questionFromCast, type Mention } from '../../agent/mentions.js';
import { decide, recordAutoReply, alreadyAutoReplied } from '../../agent/autonomy.js';
import { tierForFid } from '../../entitlements/index.js';
import { farcaster } from '../../agent/publish/farcaster.js';

/**
 * Neynar webhook: someone mentioned the agent.
 *
 * This is Neynar's documented way to hear about mentions, and it replaces
 * polling a notifications endpoint whose response shape was never verified
 * against a spec. It is also real time, and costs no polling quota.
 *
 * **The signature check is the security boundary, not a formality.** The
 * entitlement that decides whether a mention is answered autonomously hangs on
 * `data.author.fid`, which arrives inside this request body. Without
 * verification anyone could POST a forged `cast.created` naming an entitled
 * FID and make the agent reply on demand — the exact "claimed vs verified"
 * hole the entitlements module exists to keep shut. So an unsigned or
 * badly-signed request is rejected, and a missing secret disables the endpoint
 * outright rather than opening it.
 */

/** Header Neynar signs the raw request body with. */
const SIGNATURE_HEADER = 'x-neynar-signature';

export function webhookConfigured(): boolean {
  return Boolean(process.env.NEYNAR_WEBHOOK_SECRET?.trim());
}

/**
 * HMAC-SHA512 of the raw body, compared in constant time.
 *
 * The raw bytes matter: re-serialising the parsed JSON would produce a
 * different string and a signature that never matches, which is the classic
 * way this check ends up quietly disabled to "make it work".
 */
export function verifySignature(rawBody: string, signature: string | undefined): boolean {
  const secret = process.env.NEYNAR_WEBHOOK_SECRET?.trim();
  if (!secret || !signature) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The digest we expect, for diagnostics only. Null when no secret is set. */
function computedDigest(rawBody: string): string | null {
  const secret = process.env.NEYNAR_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  return createHmac('sha512', secret).update(rawBody).digest('hex');
}

interface CastCreated {
  type?: string;
  data?: {
    hash?: string;
    text?: string;
    timestamp?: string;
    author?: { fid?: number | string; username?: string };
  };
}

/** Webhook payload -> the same Mention shape the rest of the agent uses. */
export function mentionFromWebhook(body: CastCreated): Mention | null {
  const d = body.data;
  if (body.type !== 'cast.created' || !d?.hash || !d.text) return null;
  return {
    hash: d.hash,
    author: d.author?.username ?? 'unknown',
    authorFid: d.author?.fid === undefined ? null : String(d.author.fid),
    text: d.text,
    timestamp: d.timestamp ? Date.parse(d.timestamp) : Date.now(),
  };
}

export function registerWebhook(app: FastifyInstance): void {
  // Keep the raw body: the signature covers the bytes Neynar sent, not a
  // re-encoding of them.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post('/webhooks/farcaster', async (req, reply) => {
    if (!webhookConfigured()) {
      // Fail closed. An endpoint that accepts unsigned mention events is a
      // remote trigger for the agent's voice.
      return reply.code(503).send({ error: 'webhook not configured' });
    }

    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const sigHeader = req.headers[SIGNATURE_HEADER];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!verifySignature(raw, sig)) {
      // A rejection has three quite different causes -- wrong secret, wrong
      // header, wrong algorithm -- and "bad signature" distinguishes none of
      // them. Log the shape of what arrived against the shape of what was
      // expected: lengths identify the algorithm, a matching length with a
      // different prefix means the secret differs, and no candidate header at
      // all means the name is wrong. The secret is never logged, and only the
      // first bytes of a digest, which prove nothing on their own.
      const candidates = Object.keys(req.headers).filter(
        (h) => h.includes('signature') || h.includes('neynar'),
      );
      req.log.warn(
        {
          expectedHeader: SIGNATURE_HEADER,
          signatureHeadersPresent: candidates.length > 0 ? candidates : 'NONE',
          receivedLength: sig?.length ?? 0,
          receivedPrefix: sig?.slice(0, 8) ?? '',
          computedLength: computedDigest(raw)?.length ?? 0,
          computedPrefix: computedDigest(raw)?.slice(0, 8) ?? '',
          bodyBytes: raw.length,
        },
        'rejected webhook: signature did not verify',
      );
      return reply.code(401).send({ error: 'bad signature' });
    }

    const mention = mentionFromWebhook(req.body as CastCreated);
    // Neynar retries until it gets a 200, so anything we deliberately ignore
    // still has to be acknowledged or it is redelivered forever.
    if (!mention) return { ok: true, ignored: 'not a cast.created mention' };
    if (alreadyAutoReplied(mention.hash)) return { ok: true, ignored: 'already answered' };

    const { signal, answered, conversational } = await signalForMention(mention);
    // Worth saying, rather than looked up. An introduction is not a
    // measurement -- `answered` stays false so no caller reads it as one --
    // but staying silent when the agent has a good reply is the wrong
    // outcome, so the gate asks whether there is something to say.
    const worthSaying = answered || conversational;
    const verdict = decide({ fid: mention.authorFid, answered: worthSaying });

    if (!worthSaying) {
      // The text is logged because this is the branch that needs diagnosing:
      // an unanswerable mention is either genuinely off-topic or a classifier
      // gap, and those are indistinguishable without seeing what was asked.
      req.log.info(
        { fid: mention.authorFid, text: mention.text.slice(0, 200) },
        `mention from @${mention.author} not answerable; saying nothing`,
      );
      return { ok: true, ignored: 'not answerable' };
    }

    const tier = mention.authorFid ? tierForFid(mention.authorFid).tier : 'free';
    const a = await answerQuestion(questionFromCast(mention.text), new Date(), { tier });
    const verification = verifyDraft(a.text, signal.facts);
    if (!verification.ok) {
      // Two different failures, reported as two different things. An
      // unsupported number is a claim we will not make; an over-long reply is
      // one that will not fit a cast. Reporting either as a bare "failed
      // verification" with an empty list is how this hid twice.
      const why = verification.unsupported.length
        ? `unsupported numbers: ${verification.unsupported.join(', ')}`
        : `too long for a cast: ${verification.length} chars`;
      req.log.error(`answer for @${mention.author} failed verification — ${why}`);
      return { ok: true, ignored: 'failed verification' };
    }

    if (verdict.autonomous) {
      const res = await farcaster.publish(a.text, false, mention.hash);
      if (res.error) {
        req.log.error(`reply to @${mention.author} failed: ${res.error}`);
        // Still a 200: Neynar retrying the delivery will not fix a Neynar
        // publish error, and the idempotency key makes a later retry safe.
        return { ok: true, ignored: 'send failed' };
      }
      recordAutoReply({
        castHash: mention.hash,
        fid: mention.authorFid!,
        intent: a.intent.kind,
        ref: res.ref,
      });
      req.log.info(`replied to @${mention.author} [${a.intent.kind}] ${res.ref}`);
      return { ok: true, replied: true, ref: res.ref };
    }

    saveMentionSignal(signal);
    const channels = (process.env.AGENT_CHANNELS ?? 'farcaster')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const post = enqueue(
      signal.id,
      { text: a.text, draftedBy: 'answer', verification },
      channels,
      mention.hash,
    );
    req.log.info(`queued reply to @${mention.author}: ${verdict.reason}`);
    return { ok: true, queued: post?.id ?? 'already queued' };
  });
}
