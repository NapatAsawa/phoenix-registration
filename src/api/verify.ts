import type { FastifyInstance } from 'fastify';
import type { VerifyOutcome } from '../verification/service.js';

/**
 * The verification HTTP surface, kept separate from `buildApp` so the route's
 * 200/410 behavior can be driven with a fake port — no database. This is the
 * seam the person's confirmation link lands on: `GET /verify?token=...`.
 *
 * Idempotency lives below this edge (in the port): the route just maps the three
 * outcomes to status codes. Both "verified" and "already verified" are 200 — a
 * repeated or prefetched click is a success, not an error — while an expired or
 * unknown token is 410 Gone.
 */
export interface VerificationPort {
  verify(token: string): Promise<VerifyOutcome>;
}

export function registerVerificationRoutes(app: FastifyInstance, port: VerificationPort): void {
  app.get('/verify', async (request, reply) => {
    const token = (request.query as { token?: unknown }).token;
    // An absent or empty token is just an unknown token — nothing to activate,
    // so 410 like any other unknown token (the spec enumerates only 410 here).
    if (typeof token !== 'string' || token === '') {
      return reply.code(410).send({ error: 'invalid_token' });
    }

    const outcome = await port.verify(token);
    switch (outcome.status) {
      case 'verified':
        return reply.code(200).send({ status: 'verified' });
      case 'already-verified':
        // Same 200 as a first success: following the link again is safe.
        return reply.code(200).send({ status: 'already_verified' });
      case 'invalid':
        // 410 Gone: the token expired or never existed. Nothing to activate.
        return reply.code(410).send({ error: 'invalid_token' });
    }
  });
}
