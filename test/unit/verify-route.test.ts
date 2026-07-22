import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { VerificationPort } from '../../src/api/verify.js';
import type { VerifyOutcome } from '../../src/verification/service.js';

/** Health checks are irrelevant to these route tests; keep them trivially green. */
const okChecks = { pingDb: async () => {}, isQueueStarted: () => true };

function appWith(port: VerificationPort) {
  return buildApp({ checks: okChecks, verification: port });
}

function portReturning(outcome: VerifyOutcome): VerificationPort {
  return { verify: async () => outcome };
}

describe('GET /verify', () => {
  it('returns 200 verified on first success', async () => {
    const app = appWith(portReturning({ status: 'verified' }));
    const res = await app.inject({ method: 'GET', url: '/verify?token=abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'verified' });
    await app.close();
  });

  it('returns 200 already_verified on a repeat follow', async () => {
    const app = appWith(portReturning({ status: 'already-verified' }));
    const res = await app.inject({ method: 'GET', url: '/verify?token=abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'already_verified' });
    await app.close();
  });

  it('returns 410 for an expired or unknown token', async () => {
    const app = appWith(portReturning({ status: 'invalid' }));
    const res = await app.inject({ method: 'GET', url: '/verify?token=abc' });
    expect(res.statusCode).toBe(410);
    await app.close();
  });

  it('passes the raw token through to the port', async () => {
    const seen: string[] = [];
    const app = appWith({
      verify: async (token) => {
        seen.push(token);
        return { status: 'verified' };
      },
    });
    await app.inject({ method: 'GET', url: '/verify?token=tok-123' });
    expect(seen).toEqual(['tok-123']);
    await app.close();
  });

  it('returns 410 when the token is missing, without touching the port', async () => {
    let called = false;
    const app = appWith({
      verify: async () => {
        called = true;
        return { status: 'verified' };
      },
    });
    const res = await app.inject({ method: 'GET', url: '/verify' });
    expect(res.statusCode).toBe(410);
    expect(called).toBe(false);
    await app.close();
  });
});
