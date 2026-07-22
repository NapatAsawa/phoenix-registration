import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ResendPort } from '../../src/api/resend.js';
import type { ResendResult } from '../../src/registration/resend.js';

/**
 * `POST /registrations/:email/resend` maps the four Resend outcomes to status
 * codes, and normalizes the path email the same way registration stored it. No
 * database — the port is a fake. The throttle/regeneration logic lives below this
 * edge and is covered by the service + integration tests.
 */
const okChecks = { pingDb: async () => {}, isQueueStarted: () => true };

function appWith(port: ResendPort) {
  return buildApp({ checks: okChecks, resend: port });
}

function portReturning(result: ResendResult, sink?: string[]): ResendPort {
  return {
    resend: async (email) => {
      sink?.push(email);
      return result;
    },
  };
}

describe('POST /registrations/:email/resend', () => {
  it('202 accepted when a fresh Confirmation Email is queued, with a normalized email', async () => {
    const seen: string[] = [];
    const app = appWith(portReturning({ ok: true }, seen));
    const res = await app.inject({ method: 'POST', url: '/registrations/Pending@Example.com/resend' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(seen).toEqual(['pending@example.com']);
    await app.close();
  });

  it('404 for an unknown email', async () => {
    const app = appWith(portReturning({ ok: false, reason: 'not-found' }));
    const res = await app.inject({ method: 'POST', url: '/registrations/nobody@example.com/resend' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('409 when the account is already Active (not Pending)', async () => {
    const app = appWith(portReturning({ ok: false, reason: 'not-pending' }));
    const res = await app.inject({ method: 'POST', url: '/registrations/active@example.com/resend' });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('429 when the Pending account is over the interval or resend cap', async () => {
    const app = appWith(portReturning({ ok: false, reason: 'throttled' }));
    const res = await app.inject({ method: 'POST', url: '/registrations/pending@example.com/resend' });
    expect(res.statusCode).toBe(429);
    await app.close();
  });
});
