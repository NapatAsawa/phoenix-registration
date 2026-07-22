import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sweepExpiredPending, PENDING_TTL_MS } from '../../src/sweep/service.js';
import { generateVerificationToken } from '../../src/registration/token.js';
import { ACCOUNT_STATUS } from '../../src/db/schema.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';

/**
 * The Sweep (issue #6) against a real, migrated Postgres — the seam the scheduled
 * job drives, called here directly. Real Postgres is the only place the TTL
 * arithmetic (`last_confirmation_sent_at` vs `make_interval`) and the actual row
 * deletion / email freeing can be exercised.
 *
 * Rather than sleep out a 72h TTL, tests age `last_confirmation_sent_at` backwards
 * to simulate elapsed time — the same trick the resend suite uses for its
 * interval.
 */
describe('Sweep expired Pending accounts (real Postgres)', () => {
  let pg: TestPostgres;

  beforeAll(async () => {
    pg = await startTestPostgres();
  });

  afterAll(async () => {
    await pg?.teardown();
  });

  beforeEach(async () => {
    await pg.pool.query('DELETE FROM accounts');
  });

  /** Insert an account, returning its id and the plaintext token it holds. */
  async function seed(
    email: string,
    opts: {
      status?: string;
      /** How long ago the last Confirmation Email went out. */
      sentAgoMs?: number;
      /** Token expiry relative to now; negative = already expired. Null = no token. */
      tokenExpiresInMs?: number | null;
    } = {},
  ): Promise<{ id: string; token: string | null }> {
    const { status = ACCOUNT_STATUS.pending, sentAgoMs = 0, tokenExpiresInMs = 60_000 } = opts;
    const hasToken = tokenExpiresInMs !== null;
    const { token, tokenHash } = generateVerificationToken();
    const res = await pg.pool.query(
      `INSERT INTO accounts (email, password_hash, status, token_hash, token_expires_at, last_confirmation_sent_at)
       VALUES ($1, 'x', $2, $3, $4, now() - make_interval(secs => $5))
       RETURNING id`,
      [
        email,
        status,
        hasToken ? tokenHash : null,
        hasToken ? new Date(Date.now() + (tokenExpiresInMs as number)) : null,
        sentAgoMs / 1000,
      ],
    );
    return { id: res.rows[0].id as string, token: hasToken ? token : null };
  }

  async function exists(email: string): Promise<boolean> {
    const res = await pg.pool.query('SELECT 1 FROM accounts WHERE email = $1', [email]);
    return res.rows.length > 0;
  }

  it('hard-deletes a Pending account older than the TTL, freeing its email', async () => {
    await seed('stale@example.com', { sentAgoMs: PENDING_TTL_MS + 60_000 });

    const result = await sweepExpiredPending(pg.pool);

    expect(result.expiredAccounts).toBe(1);
    expect(await exists('stale@example.com')).toBe(false);

    // Email is free: a fresh insert with the same address now succeeds.
    await expect(seed('stale@example.com', { sentAgoMs: 0 })).resolves.toBeDefined();
  });

  it('keeps a Pending account still within the window', async () => {
    await seed('fresh@example.com', { sentAgoMs: PENDING_TTL_MS - 60 * 60 * 1000 });

    const result = await sweepExpiredPending(pg.pool);

    expect(result.expiredAccounts).toBe(0);
    expect(await exists('fresh@example.com')).toBe(true);
  });

  it('never expires an Active account, however old', async () => {
    await seed('active@example.com', {
      status: ACCOUNT_STATUS.active,
      sentAgoMs: PENDING_TTL_MS * 10,
      tokenExpiresInMs: 60_000,
    });

    await sweepExpiredPending(pg.pool);

    expect(await exists('active@example.com')).toBe(true);
  });

  it('treats a Resend as keeping the account alive (recent last_confirmation_sent_at survives)', async () => {
    // Registered long ago, but a Resend bumped last_confirmation_sent_at recently.
    await seed('resent@example.com', { sentAgoMs: 60 * 60 * 1000 });

    const result = await sweepExpiredPending(pg.pool);

    expect(result.expiredAccounts).toBe(0);
    expect(await exists('resent@example.com')).toBe(true);
  });

  it('clears a consumed/expired token from an Active account but leaves the account', async () => {
    await seed('verified@example.com', {
      status: ACCOUNT_STATUS.active,
      tokenExpiresInMs: -60_000, // token already expired
    });

    const result = await sweepExpiredPending(pg.pool);

    expect(result.clearedTokens).toBe(1);
    const row = await pg.pool.query(
      'SELECT token_hash, token_expires_at, status FROM accounts WHERE email = $1',
      ['verified@example.com'],
    );
    expect(row.rows[0].token_hash).toBeNull();
    expect(row.rows[0].token_expires_at).toBeNull();
    expect(row.rows[0].status).toBe(ACCOUNT_STATUS.active);
  });

  it('leaves a still-valid token untouched', async () => {
    await seed('valid@example.com', {
      status: ACCOUNT_STATUS.active,
      tokenExpiresInMs: 60 * 60 * 1000, // still in the future
    });

    const result = await sweepExpiredPending(pg.pool);

    expect(result.clearedTokens).toBe(0);
    const row = await pg.pool.query('SELECT token_hash FROM accounts WHERE email = $1', [
      'valid@example.com',
    ]);
    expect(row.rows[0].token_hash).not.toBeNull();
  });

  it('honors a custom TTL override', async () => {
    await seed('short@example.com', { sentAgoMs: 5000 });

    // A 1s TTL expires the 5s-old account; the default 72h would not.
    const result = await sweepExpiredPending(pg.pool, 1000);

    expect(result.expiredAccounts).toBe(1);
    expect(await exists('short@example.com')).toBe(false);
  });

  it('sweeps a mixed table: expires the stale, survives the fresh, in one pass', async () => {
    await seed('gone1@example.com', { sentAgoMs: PENDING_TTL_MS + 1000 });
    await seed('gone2@example.com', { sentAgoMs: PENDING_TTL_MS + 1000 });
    await seed('keep@example.com', { sentAgoMs: 1000 });
    await seed('active@example.com', { status: ACCOUNT_STATUS.active, sentAgoMs: PENDING_TTL_MS + 1000 });

    const result = await sweepExpiredPending(pg.pool);

    expect(result.expiredAccounts).toBe(2);
    expect(await exists('gone1@example.com')).toBe(false);
    expect(await exists('gone2@example.com')).toBe(false);
    expect(await exists('keep@example.com')).toBe(true);
    expect(await exists('active@example.com')).toBe(true);
  });
});
