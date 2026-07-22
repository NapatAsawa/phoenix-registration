import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { Queue } from '../../src/queue/queue.js';
import { readinessChecks } from '../../src/runtime.js';
import { registerAccount } from '../../src/registration/service.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../../src/queue/jobs.js';
import { makeConfirmationEmailHandler } from '../../src/email/confirmation-handler.js';
import { hashToken } from '../../src/registration/token.js';
import type { EmailMessage, EmailSender } from '../../src/email/sender.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';

/**
 * End-to-end against a real, migrated Postgres and a real pg-boss queue: a valid
 * POST creates a Pending Account and enqueues the Confirmation Email; a running
 * worker consumes it and sends an email whose token's sha256 is what we stored.
 * The worker consuming the job at all proves the enqueue committed with the
 * account (the atomic-rollback half is covered by the service unit test).
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

describe('registration → confirmation email (real Postgres + queue)', () => {
  let pg: TestPostgres;
  let queue: Queue;
  let app: FastifyInstance;
  const sender = new CapturingSender();

  beforeAll(async () => {
    pg = await startTestPostgres();
    queue = new Queue(pg.databaseUrl);
    await queue.start();
    await queue.createQueue(CONFIRMATION_EMAIL_QUEUE);

    // A real worker consuming the same queue the API enqueues to.
    const handler = makeConfirmationEmailHandler({
      db: pg.pool,
      emailSender: sender,
      publicBaseUrl: BASE_URL,
    });
    await queue.work<ConfirmationEmailJob>(CONFIRMATION_EMAIL_QUEUE, handler);

    app = buildApp({
      checks: readinessChecks({ pool: pg.pool, queue }),
      registration: { register: (input) => registerAccount({ pool: pg.pool, queue }, input) },
    });
  });

  afterAll(async () => {
    await app?.close();
    await queue?.stop();
    await pg?.teardown();
  });

  it('valid registration → 202, Pending account with an argon2id hash, confirmation email with a stored-as-sha256 token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'Alice@Example.com', password: 'longenough' },
    });
    expect(res.statusCode).toBe(202);

    // Pending account, password stored only as an argon2id hash.
    const account = await pg.pool.query(
      'SELECT id, email, status, password_hash FROM accounts WHERE email = $1',
      ['alice@example.com'],
    );
    expect(account.rows[0]).toMatchObject({ email: 'alice@example.com', status: 'pending' });
    expect(account.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(account.rows[0].password_hash).not.toContain('longenough');

    // Worker sent the Confirmation Email — proves the job committed with the account.
    const message = await waitFor(() => sender.sent.find((m) => m.to === 'alice@example.com'));
    const url = new URL(message.body.match(/https?:\/\/\S+/)![0]);
    expect(url.origin + url.pathname).toBe(`${BASE_URL}/verify`);
    const token = url.searchParams.get('token')!;
    expect(token).toBeTruthy();

    // Token stored as sha256, never plaintext, with an expiry.
    const stored = await pg.pool.query(
      'SELECT token_hash, token_expires_at FROM accounts WHERE email = $1',
      ['alice@example.com'],
    );
    expect(stored.rows[0].token_hash).toBe(hashToken(token));
    expect(stored.rows[0].token_hash).not.toBe(token);
    expect(stored.rows[0].token_expires_at).toBeInstanceOf(Date);
  });

  it('malformed email → 400, no account created', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'nope', password: 'longenough' },
    });
    expect(res.statusCode).toBe(400);
    const count = await pg.pool.query('SELECT count(*)::int AS n FROM accounts');
    expect(count.rows[0].n).toBe(1); // only the one from the first test
  });

  it('out-of-range password → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'bob@example.com', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('duplicate of an already-Active email → 409, no second account', async () => {
    // Once alice's account is Active, a second registration is a genuine collision
    // (a still-Pending duplicate would instead be a throttled Resend — issue #5).
    await pg.pool.query(`UPDATE accounts SET status = 'active' WHERE email = $1`, ['alice@example.com']);

    const res = await app.inject({
      method: 'POST',
      url: '/registrations',
      payload: { email: 'alice@example.com', password: 'anotherpass' },
    });
    expect(res.statusCode).toBe(409);
    const count = await pg.pool.query('SELECT count(*)::int AS n FROM accounts WHERE email = $1', [
      'alice@example.com',
    ]);
    expect(count.rows[0].n).toBe(1);
  });
});
