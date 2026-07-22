import type { FastifyInstance } from 'fastify';
import { parseRegistration } from '../registration/validation.js';
import type { RegisterResult } from '../registration/service.js';
import type { RegistrationInput } from '../registration/validation.js';

/**
 * The registration HTTP surface, kept separate from `buildApp` so the route's
 * 202/400/409 behavior can be driven with a fake port — no database or queue.
 * Validation lives at this edge; the port receives only clean input.
 */
export interface RegistrationPort {
  register(input: RegistrationInput): Promise<RegisterResult>;
}

export function registerRegistrationRoutes(app: FastifyInstance, port: RegistrationPort): void {
  app.post('/registrations', async (request, reply) => {
    const parsed = parseRegistration(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'invalid_registration', details: parsed.errors });
    }

    const result = await port.register(parsed.value);
    if (!result.ok) {
      if (result.reason === 'throttled') {
        // A still-Pending email asked to (re)send too soon or too often (#5).
        return reply.code(429).send({ error: 'resend_throttled' });
      }
      // Email already taken by an Active account. 409 is honest about why; the
      // account is unchanged.
      return reply.code(409).send({ error: 'email_taken' });
    }

    // 202: the account is Pending and the Confirmation Email is queued, not yet
    // sent — the work is accepted, not complete. A still-Pending re-registration
    // returns the same 202 (it was handled as a Resend).
    return reply.code(202).send({ status: 'accepted' });
  });
}
