import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Queue } from '../../src/queue/queue.js';
import { readinessChecks } from '../../src/runtime.js';
import { registerAccount } from '../../src/registration/service.js';
import { resendConfirmation } from '../../src/registration/resend.js';
import { verifyToken } from '../../src/verification/service.js';
import { setupConfirmationEmailQueues } from '../../src/queue/setup.js';
import { LatestLinkStore, recordConfirmationLinks } from '../../src/dev/latest-link.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';

/**
 * The issue #8 demo surface end-to-end against a real, migrated Postgres + pg-boss,
 * wired exactly as the API entrypoint wires it: the recording enqueuer captures the
 * confirmation link at enqueue time, so `GET /dev/latest-link` returns a link whose
 * token actually verifies. No worker runs — the link is available the instant the
 * account is created, which is the whole point of the dev endpoint.
 */
const BASE_URL = 'https://phoenix.example';

describe('demo flow: register → reveal latest link → verify (real Postgres + queue)', () => {
  let pg: TestPostgres;
  let queue: Queue;
  let app: FastifyInstance;
  const latestLinks = new LatestLinkStore();

  beforeAll(async () => {
    pg = await startTestPostgres();
    queue = new Queue(pg.databaseUrl);
    await queue.start();
    await setupConfirmationEmailQueues(queue);

    const enqueuer = recordConfirmationLinks(queue, latestLinks, BASE_URL);
    app = buildApp({
      checks: readinessChecks({ pool: pg.pool, queue }),
      registration: { register: (input) => registerAccount({ pool: pg.pool, queue: enqueuer }, input) },
      resend: { resend: (email) => resendConfirmation({ pool: pg.pool, queue: enqueuer }, email) },
      verification: { verify: (token) => verifyToken(pg.pool, token) },
      ui: true,
      latestLink: latestLinks,
    });
  });

  afterAll(async () => {
    await app?.close();
    await queue?.stop();
    await pg?.teardown();
  });

  it('serves the demo UI at /', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Phoenix Registration');
  });

  it('registering makes the latest link available, and its token verifies', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'demo@example.com', password: 'longenough' },
    });
    expect(reg.statusCode).toBe(202);

    // The dev endpoint returns the link built for the just-created account.
    const link = await app.inject({ method: 'GET', url: '/dev/latest-link' });
    expect(link.statusCode).toBe(200);
    const url = new URL(link.json<{ link: string }>().link);
    expect(url.origin + url.pathname).toBe(`${BASE_URL}/verify`);
    const token = url.searchParams.get('token')!;
    expect(token).toBeTruthy();

    // Following that token activates the account.
    const verify = await app.inject({ method: 'GET', url: `/verify?token=${encodeURIComponent(token)}` });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toMatchObject({ status: 'verified' });
  });

  it('a Resend refreshes the latest link to the new token', async () => {
    // Seed a fresh Pending account whose last send is old enough to clear the throttle.
    await pg.pool.query(
      `INSERT INTO accounts (email, password_hash, status, token_hash, last_confirmation_sent_at)
       VALUES ($1, 'x', 'pending', 'stale-hash', now() - make_interval(secs => 3600))`,
      ['resend@example.com'],
    );

    const before = latestLinks.latest()?.link;
    const res = await app.inject({ method: 'POST', url: '/registrations/resend@example.com/resend' });
    expect(res.statusCode).toBe(202);

    const link = latestLinks.latest()!;
    expect(link.link).not.toBe(before);
    // The refreshed link's token is the one now stored (as sha256) on the account.
    expect(new URL(link.link).searchParams.get('token')).toBeTruthy();
  });
});
