import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import { DOMAIN_EVENT } from '../../src/observability/log.js';
import { captureLogger } from '../helpers/capture-logger.js';

/**
 * The two request-path domain events (issue #7): a 202 registration emits
 * `registration.accepted`, a 200 verify emits `account.verified`. Both must ride
 * on a line that also carries the Fastify per-request `reqId`, so the workflow is
 * traceable. Driven with fake ports and a capturing pino instance.
 */
const okChecks = { pingDb: async () => {}, isQueueStarted: () => true };

describe('domain-event log lines on the request path', () => {
  it('emits registration.accepted with the accountId and a reqId on a 202', async () => {
    const cap = captureLogger();
    const app = buildApp({
      checks: okChecks,
      logger: cap.logger,
      registration: { register: async () => ({ ok: true, outcome: 'created', accountId: 'acc-9' }) },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'alice@example.com', password: 'longenough' },
    });
    expect(res.statusCode).toBe(202);

    const events = cap.withEvent(DOMAIN_EVENT.registrationAccepted);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'created', accountId: 'acc-9' });
    expect(events[0]!.reqId).toBeDefined();
    await app.close();
  });

  it('does not emit registration.accepted on a 409 duplicate', async () => {
    const cap = captureLogger();
    const app = buildApp({
      checks: okChecks,
      logger: cap.logger,
      registration: { register: async () => ({ ok: false, reason: 'duplicate-email' }) },
    });

    await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'alice@example.com', password: 'longenough' },
    });

    expect(cap.withEvent(DOMAIN_EVENT.registrationAccepted)).toHaveLength(0);
    await app.close();
  });

  it('emits account.verified with the accountId and a reqId on a 200 verify', async () => {
    const cap = captureLogger();
    const app = buildApp({
      checks: okChecks,
      logger: cap.logger,
      verification: { verify: async () => ({ status: 'verified', accountId: 'acc-3' }) },
    });

    const res = await app.inject({ method: 'GET', url: '/verify?token=abc' });
    expect(res.statusCode).toBe(200);

    const events = cap.withEvent(DOMAIN_EVENT.accountVerified);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ accountId: 'acc-3' });
    expect(events[0]!.reqId).toBeDefined();
    await app.close();
  });

  it('does not emit account.verified on an already-verified follow', async () => {
    const cap = captureLogger();
    const app = buildApp({
      checks: okChecks,
      logger: cap.logger,
      verification: { verify: async () => ({ status: 'already-verified' }) },
    });

    await app.inject({ method: 'GET', url: '/verify?token=abc' });
    expect(cap.withEvent(DOMAIN_EVENT.accountVerified)).toHaveLength(0);
    await app.close();
  });
});
