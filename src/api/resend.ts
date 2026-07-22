import type { FastifyInstance } from 'fastify';
import { normalizeEmail } from '../registration/validation.js';
import type { ResendResult } from '../registration/resend.js';

/**
 * The Resend HTTP surface: `POST /registrations/{email}/resend`. Kept separate
 * from `buildApp` so its 202/404/409/429 mapping can be driven with a fake port —
 * no database or queue.
 *
 * The throttle and token regeneration live below this edge (in the port); the
 * route only normalizes the path email (so it matches the stored form) and maps
 * the four outcomes to status codes. A queued Resend is 202 — accepted, not yet
 * delivered — mirroring registration.
 */
export interface ResendPort {
  resend(email: string): Promise<ResendResult>;
}

export function registerResendRoutes(app: FastifyInstance, port: ResendPort): void {
  app.post('/registrations/:email/resend', async (request, reply) => {
    const rawEmail = (request.params as { email: string }).email;
    const email = normalizeEmail(rawEmail);

    const result = await port.resend(email);
    if (result.ok) {
      return reply.code(202).send({ status: 'accepted' });
    }
    switch (result.reason) {
      case 'not-found':
        // No Pending Account ever existed for this email.
        return reply.code(404).send({ error: 'not_found' });
      case 'not-pending':
        // The Account exists but is Active — nothing to resend.
        return reply.code(409).send({ error: 'already_active' });
      case 'throttled':
        // Too soon since the last send, or the resend cap is reached.
        return reply.code(429).send({ error: 'resend_throttled' });
    }
  });
}
