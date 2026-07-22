import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Queue } from '../../src/queue/queue.js';
import { startWorker } from '../../src/worker/run.js';
import { registerAccount } from '../../src/registration/service.js';
import { verifyToken } from '../../src/verification/service.js';
import {
  CONFIRMATION_EMAIL_QUEUE,
  CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
  SWEEP_QUEUE,
} from '../../src/queue/jobs.js';
import { DOMAIN_EVENT } from '../../src/observability/log.js';
import { ACCOUNT_STATUS } from '../../src/db/schema.js';
import type { EmailMessage, EmailSender } from '../../src/email/sender.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';
import { captureLogger, type CapturedLogger } from '../helpers/capture-logger.js';

/**
 * Delivery reliability (issue #7) against a real Postgres + pg-boss, driving the
 * worker composition (startWorker) exactly as production does. Two independent
 * setups because the two scenarios need different email transports (a failing one
 * to force dead-lettering, a capturing one for the happy path).
 */
const BASE_URL = 'https://phoenix.example';

/** Fails every send, so a Confirmation Email job exhausts its retries. */
class ThrowingSender implements EmailSender {
  async send(): Promise<void> {
    throw new Error('smtp unavailable');
  }
}

/** Records what it "sends" so the happy path can read back the confirmation link. */
class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 150));
  }
}

describe('confirmation email retries then dead-letters (real Postgres + queue)', () => {
  let pg: TestPostgres;
  let queue: Queue;
  let cap: CapturedLogger;

  beforeAll(async () => {
    pg = await startTestPostgres();
    queue = new Queue(pg.databaseUrl);
    await queue.start();

    // Pre-create the queues with a *fast* retry policy (1 retry, no backoff) so the
    // dead-letter path is exercised in seconds. createQueue is create-once, so the
    // production policy startWorker also sets is a no-op here — the test policy wins.
    await queue.createQueue(CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE);
    await queue.createQueue(CONFIRMATION_EMAIL_QUEUE, {
      retryLimit: 1,
      retryBackoff: false,
      deadLetter: CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
    });

    cap = captureLogger();
    await startWorker({
      pool: pg.pool,
      queue,
      emailSender: new ThrowingSender(),
      logger: cap.logger,
      publicBaseUrl: BASE_URL,
      pendingTtlMs: 72 * 60 * 60 * 1000,
    });
  });

  afterAll(async () => {
    await queue?.stop();
    await pg?.teardown();
  });

  it('exhausts retries, dead-letters at error, and leaves the account Pending', async () => {
    const result = await registerAccount(
      { pool: pg.pool, queue },
      { email: 'dead@example.com', password: 'longenough' },
    );
    expect(result.ok).toBe(true);
    const accountId = result.ok && result.outcome === 'created' ? result.accountId : undefined;
    expect(accountId).toBeTruthy();

    // The job is retried, then dead-lettered — the worker logs it at error.
    const deadLettered = await waitFor(() => cap.withEvent(DOMAIN_EVENT.confirmationEmailDeadLettered)[0]);
    expect(deadLettered).toMatchObject({ accountId, level: 50 }); // pino error level
    expect(deadLettered.reqId).toBeDefined();

    // No success line was ever emitted, and the account stays Pending so a resend
    // is still possible (ADR-0002).
    expect(cap.withEvent(DOMAIN_EVENT.confirmationEmailSent)).toHaveLength(0);
    const account = await pg.pool.query('SELECT status FROM accounts WHERE id = $1', [accountId]);
    expect(account.rows[0].status).toBe(ACCOUNT_STATUS.pending);
  });
});

describe('confirmation email happy path + at-least-once verify (real Postgres + queue)', () => {
  let pg: TestPostgres;
  let queue: Queue;
  let cap: CapturedLogger;
  const sender = new CapturingSender();

  beforeAll(async () => {
    pg = await startTestPostgres();
    queue = new Queue(pg.databaseUrl);
    await queue.start();
    cap = captureLogger();

    // A short Pending TTL so the sweep expires a seeded stale account promptly.
    await startWorker({
      pool: pg.pool,
      queue,
      emailSender: sender,
      logger: cap.logger,
      publicBaseUrl: BASE_URL,
      pendingTtlMs: 1000,
    });
  });

  afterAll(async () => {
    await queue?.stop();
    await pg?.teardown();
  });

  it('sends the Confirmation Email, logs confirmation_email.sent, and tolerates duplicate delivery on verify', async () => {
    const result = await registerAccount(
      { pool: pg.pool, queue },
      { email: 'happy@example.com', password: 'longenough' },
    );
    const accountId = result.ok && result.outcome === 'created' ? result.accountId : undefined;

    // Worker delivered and logged the send with the accountId + a per-job reqId.
    const sentEvent = await waitFor(() => cap.withEvent(DOMAIN_EVENT.confirmationEmailSent)[0]);
    expect(sentEvent).toMatchObject({ accountId });
    expect(sentEvent.reqId).toBeDefined();

    const message = await waitFor(() => sender.sent.find((m) => m.to === 'happy@example.com'));
    const token = new URL(message.body.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

    // At-least-once delivery means the same link may be followed twice. Verifying
    // is idempotent: first flips to Active, the duplicate is a harmless repeat.
    expect(await verifyToken(pg.pool, token)).toMatchObject({ status: 'verified' });
    expect(await verifyToken(pg.pool, token)).toEqual({ status: 'already-verified' });
  });

  it('the Sweep expires a stale Pending account and logs account.expired', async () => {
    const seeded = await pg.pool.query(
      `INSERT INTO accounts (email, password_hash, status, last_confirmation_sent_at)
       VALUES ($1, 'x', $2, now() - make_interval(secs => 3600))
       RETURNING id`,
      ['stale@example.com', ACCOUNT_STATUS.pending],
    );
    const staleId = seeded.rows[0].id as string;

    // Trigger the (normally hourly) Sweep on demand.
    await queue.send(SWEEP_QUEUE);

    const expired = await waitFor(() =>
      cap.withEvent(DOMAIN_EVENT.accountExpired).find((l) => l.accountId === staleId),
    );
    expect(expired.reqId).toBeDefined();

    const gone = await pg.pool.query('SELECT 1 FROM accounts WHERE id = $1', [staleId]);
    expect(gone.rows).toHaveLength(0);
  });
});
