import type { FastifyInstance } from 'fastify';
import { answerQuestion } from '../../answer/answer.js';

/**
 * POST /ask -- the conversational surface, for other agents.
 *
 * Free text in, a structured answer out. `facts` carries every number the text
 * cites and `reproduce` names the call that reproduces it, so a caller can
 * verify the answer instead of trusting it. That is the whole point: an agent
 * quoting this one should be able to show its work.
 *
 * No model runs in this path. Intent detection is keyword matching over a
 * closed set and every answer is built from the index, so the endpoint is
 * deterministic, free to serve, and safe to call in a loop.
 *
 *   curl -X POST localhost:8080/ask -H 'content-type: application/json' \
 *     -d '{"question":"when is the next NVDA dividend?"}'
 */
export function registerAsk(app: FastifyInstance): void {
  app.post('/ask', async (req, reply) => {
    const body = req.body as { question?: unknown } | undefined;
    const question = typeof body?.question === 'string' ? body.question.trim() : '';

    if (!question) {
      return reply.code(400).send({ error: 'body must be {"question": "<text>"}' });
    }
    if (question.length > 500) {
      return reply.code(400).send({ error: 'question too long (max 500 chars)' });
    }

    const a = await answerQuestion(question);
    return {
      answered: a.answered,
      answer: a.text,
      intent: a.intent.kind,
      symbol: a.intent.symbol,
      facts: a.facts,
      reproduce: a.reproduce,
    };
  });

  // GET for convenience: an agent poking at the service by hand should not
  // have to construct a POST body to find out what it can ask.
  app.get('/ask', async (req, reply) => {
    const q = (req.query as { q?: string } | undefined)?.q?.trim();
    if (!q) {
      return reply.code(400).send({
        error: 'pass ?q=<question>, or POST {"question": "..."}',
        answers: [
          'how many pools quote NVDA',
          'when is the next NVDA dividend',
          'does TSLA have a chainlink feed',
          'what is the v3/v4 volume split',
          'is the gas subsidy still active',
        ],
      });
    }
    const a = await answerQuestion(q);
    return {
      answered: a.answered, answer: a.text, intent: a.intent.kind,
      symbol: a.intent.symbol, facts: a.facts, reproduce: a.reproduce,
    };
  });
}
