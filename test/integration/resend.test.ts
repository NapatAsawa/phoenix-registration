import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Queue } from '../../src/queue/queue.js';
import { readinessChecks } from '../../src/runtime.js';
import { registerAccount } from '../../src/registration/service.js';
import {
  resendConfirmation,
  RESEND_MAX_COUNT,
} from '../../src/registration/resend.js';
import { verifyToken } from '../../src/verification/service.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../../src/queue/jobs.js';
import { makeConfirmationEmailHandler } from '../../src/email/confirmation-handler.js';
import { hashToken } from '../../src/registration/token.js';
import type { EmailMessage, EmailSender } from '../../src/email/sender.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';

/**
 * Duplicate handling + Resend + Layer-1 throttle (issue #5) against a real,
 * migrated Postgres and a real pg-boss queue — the only place the throttle's
 * interval/cap and token invalidation can actually be exercised. Covers 409 on an
 * Active email, resend-on-Pending (fresh email + old token invalidated), the
 * resend endpoint's 404/409/429, and the throttle interval + cap.
 *
 * The 60s interval is enforced by Postgres against `last_confirmation_sent_at`;
 * rather than sleep, the tests move that timestamp back to simulate elapsed time.
 */
class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

const BASE_URL = 'https://phoenix.example';

async function waitFor<T>(get: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('duplicate + resend + throttle (real Postgres + queue)', () => {
  let pg: TestPostgres;
  let queue: Queue;
  let app: FastifyInstance;
  const sender = new CapturingSender();

  beforeAll(async () => {
    pg = await startTestPostgres();
    queue = new Queue(pg.databaseUrl);
    await queue.start();
    await queue.createQueue(CONFIRMATION_EMAIL_QUEUE);

    const handler = makeConfirmationEmailHandler({
      db: pg.pool,
      emailSender: sender,
      publicBaseUrl: BASE_URL,
    });
    await queue.work<ConfirmationEmailJob>(CONFIRMATION_EMAIL_QUEUE, handler);

    app = buildApp({
      checks: readinessChecks({ pool: pg.pool, queue }),
      registration: { register: (input) => registerAccount({ pool: pg.pool, queue }, input) },
      resend: { resend: (email) => resendConfirmation({ pool: pg.pool, queue }, email) },
      verification: { verify: (token) => verifyToken(pg.pool, token) },
    });
  });

  afterAll(async () => {
    await app?.close();
    await queue?.stop();
    await pg?.teardown();
  });

  async function register(email: string, password = 'longenough') {
    return app.inject({ method: 'POST', url: '/registrations', payload: { email, password } });
  }

  async function resend(email: string) {
    return app.inject({ method: 'POST', url: `/registrations/${email}/resend` });
  }

  /** Pretend the last Confirmation Email went out `seconds` ago, clearing the interval guard. */
  async function ageLastSend(email: string, seconds = 61) {
    await pg.pool.query(
      `UPDATE accounts SET last_confirmation_sent_at = now() - make_interval(secs => $2) WHERE email = $1`,
      [email, seconds],
    );
  }

  async function tokenHashOf(email: string): Promise<string | null> {
    const res = await pg.pool.query('SELECT token_hash FROM accounts WHERE email = $1', [email]);
    return (res.rows[0]?.token_hash as string | null) ?? null;
  }

  it('registering an already-Active email returns 409', async () => {
    await register('active@example.com');
    // Verify it so the account is Active.
    const hash = await tokenHashOf('active@example.com');
    await pg.pool.query(`UPDATE accounts SET status = 'active' WHERE email = $1`, ['active@example.com']);
    expect(hash).toBeTruthy();

    const res = await register('active@example.com', 'differentpass');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'email_taken' });
  });

  it('registering a still-Pending email is a Resend: fresh email, previous token invalidated', async () => {
    await register('pending@example.com');
    const firstHash = await tokenHashOf('pending@example.com');
    const firstMessage = await waitFor(() =>
      sender.sent.find((m) => m.to === 'pending@example.com'),
    );
    const firstToken = new URL(firstMessage.body.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    // Second registration within the interval would be throttled; simulate elapsed time.
    await ageLastSend('pending@example.com');
    const res = await register('pending@example.com', 'anotherpass');
    expect(res.statusCode).toBe(202);

    // A new token is stored, and the old one no longer verifies (410).
    const secondHash = await tokenHashOf('pending@example.com');
    expect(secondHash).toBeTruthy();
    expect(secondHash).not.toBe(firstHash);

    const staleVerify = await app.inject({ method: 'GET', url: `/verify?token=${firstToken}` });
    expect(staleVerify.statusCode).toBe(410);

    // A fresh Confirmation Email carrying the new token is delivered by the worker.
    const secondMessage = await waitFor(() =>
      sender.sent.find(
        (m) =>
          m.to === 'pending@example.com' &&
          hashToken(new URL(m.body.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!) ===
            secondHash,
      ),
    );
    const latestToken = new URL(
      secondMessage.body.match(/https?:\/\/\S+/)![0],
    ).searchParams.get('token')!;
    expect(hashToken(latestToken)).toBe(secondHash);
  });

  it('resend endpoint regenerates the token and enqueues a new Confirmation Email', async () => {
    await register('endpoint@example.com');
    const before = await tokenHashOf('endpoint@example.com');
    const sentBefore = sender.sent.filter((m) => m.to === 'endpoint@example.com').length;

    await ageLastSend('endpoint@example.com');
    const res = await resend('endpoint@example.com');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });

    const after = await tokenHashOf('endpoint@example.com');
    expect(after).not.toBe(before);
    await waitFor(() =>
      sender.sent.filter((m) => m.to === 'endpoint@example.com').length > sentBefore || undefined,
    );
  });

  it('resend for an unknown email returns 404', async () => {
    const res = await resend('ghost@example.com');
    expect(res.statusCode).toBe(404);
  });

  it('resend for an Active (non-Pending) email returns 409', async () => {
    await register('active2@example.com');
    await pg.pool.query(`UPDATE accounts SET status = 'active' WHERE email = $1`, ['active2@example.com']);
    const res = await resend('active2@example.com');
    expect(res.statusCode).toBe(409);
  });

  it('throttle interval: a second resend within 60s returns 429, then succeeds once the interval passes', async () => {
    await register('interval@example.com');

    // Immediately after registration: inside the 60s window → 429.
    const tooSoon = await resend('interval@example.com');
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json()).toEqual({ error: 'resend_throttled' });

    // Once 60s have effectively elapsed, the same resend is allowed.
    await ageLastSend('interval@example.com');
    const allowed = await resend('interval@example.com');
    expect(allowed.statusCode).toBe(202);
  });

  it(`throttle cap: at most ${RESEND_MAX_COUNT} resends per Pending account, then 429`, async () => {
    await register('cap@example.com');

    // Each resend needs the interval clear; age the timestamp before every attempt
    // so only the cap (not the interval) can stop us.
    for (let i = 0; i < RESEND_MAX_COUNT; i++) {
      await ageLastSend('cap@example.com');
      const ok = await resend('cap@example.com');
      expect(ok.statusCode).toBe(202);
    }

    // The (cap+1)th resend is refused even though the interval is clear.
    await ageLastSend('cap@example.com');
    const overCap = await resend('cap@example.com');
    expect(overCap.statusCode).toBe(429);

    const count = await pg.pool.query('SELECT resend_count FROM accounts WHERE email = $1', [
      'cap@example.com',
    ]);
    expect(count.rows[0].resend_count).toBe(RESEND_MAX_COUNT);
  });
});
