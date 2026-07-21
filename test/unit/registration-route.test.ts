import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { RegistrationPort } from '../../src/api/registrations.js';
import type { RegisterResult } from '../../src/registration/service.js';

/** Health checks are irrelevant to these route tests; keep them trivially green. */
const okChecks = { pingDb: async () => {}, isQueueStarted: () => true };

function appWith(port: RegistrationPort) {
  return buildApp({ checks: okChecks, registration: port });
}

describe('POST /registrations', () => {
  it('returns 202 for a valid registration and calls the port with normalized input', async () => {
    const calls: unknown[] = [];
    const port: RegistrationPort = {
      register: async (input) => {
        calls.push(input);
        return { ok: true, accountId: 'acc-1' } satisfies RegisterResult;
      },
    };
    const app = appWith(port);

    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'Alice@Example.com', password: 'longenough' },
    });

    expect(res.statusCode).toBe(202);
    expect(calls).toEqual([{ email: 'alice@example.com', password: 'longenough' }]);
    await app.close();
  });

  it('returns 400 for a malformed email without touching the port', async () => {
    let called = false;
    const port: RegistrationPort = {
      register: async () => {
        called = true;
        return { ok: true, accountId: 'x' };
      },
    };
    const app = appWith(port);

    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'not-an-email', password: 'longenough' },
    });

    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  it('returns 400 for an out-of-range password', async () => {
    const app = appWith({ register: async () => ({ ok: true, accountId: 'x' }) });
    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'a@b.co', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 409 when the email is already registered', async () => {
    const app = appWith({ register: async () => ({ ok: false, reason: 'duplicate-email' }) });
    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'a@b.co', password: 'longenough' },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});
