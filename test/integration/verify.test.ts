import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { verifyToken } from '../../src/verification/service.js';
import { generateVerificationToken, VERIFICATION_TOKEN_TTL_MS } from '../../src/registration/token.js';
import { ACCOUNT_STATUS } from '../../src/db/schema.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';

/**
 * `GET /verify` against a real, migrated Postgres — the only place the atomic
 * conditional UPDATE's concurrency guarantee (ADR-0002) can actually be
 * exercised. Covers first-success, idempotent repeat, expired, unknown, and the
 * concurrent race through the HTTP seam.
 */

/** Health checks are irrelevant here; keep them trivially green. */
const okChecks = { pingDb: async () => {}, isQueueStarted: () => true };

interface SeededAccount {
  token: string;
  id: string;
}

describe('GET /verify (real Postgres)', () => {
  let pg: TestPostgres;
  let app: FastifyInstance;

  beforeAll(async () => {
    pg = await startTestPostgres();
    app = buildApp({
      checks: okChecks,
      verification: { verify: (token) => verifyToken(pg.pool, token) },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pg?.teardown();
  });

  /** Insert a Pending account holding `token`'s hash, expiring `ttlMs` from now. */
  async function seedPending(email: string, ttlMs = VERIFICATION_TOKEN_TTL_MS): Promise<SeededAccount> {
    const { token, tokenHash } = generateVerificationToken();
    const expiresAt = new Date(Date.now() + ttlMs);
    const res = await pg.pool.query(
      `INSERT INTO accounts (email, password_hash, status, token_hash, token_expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [email, 'x', ACCOUNT_STATUS.pending, tokenHash, expiresAt],
    );
    return { token, id: res.rows[0].id as string };
  }

  async function statusOf(id: string): Promise<string> {
    const res = await pg.pool.query('SELECT status FROM accounts WHERE id = $1', [id]);
    return res.rows[0].status as string;
  }

  it('first valid verify → 200 verified, account is now Active', async () => {
    const { token, id } = await seedPending('first@example.com');
    const res = await app.inject({ method: 'GET', url: `/verify?token=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'verified' });
    expect(await statusOf(id)).toBe(ACCOUNT_STATUS.active);
  });

  it('repeat verify on an already-Active account → 200 already_verified, not an error', async () => {
    const { token } = await seedPending('repeat@example.com');
    const first = await app.inject({ method: 'GET', url: `/verify?token=${token}` });
    expect(first.json()).toEqual({ status: 'verified' });

    const second = await app.inject({ method: 'GET', url: `/verify?token=${token}` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: 'already_verified' });
  });

  it('expired token → 410, account left Pending', async () => {
    const { token, id } = await seedPending('expired@example.com', -1000);
    const res = await app.inject({ method: 'GET', url: `/verify?token=${token}` });
    expect(res.statusCode).toBe(410);
    expect(await statusOf(id)).toBe(ACCOUNT_STATUS.pending);
  });

  it('unknown token → 410', async () => {
    const res = await app.inject({ method: 'GET', url: '/verify?token=never-existed' });
    expect(res.statusCode).toBe(410);
  });

  it('concurrent verifies of the same token → exactly one activation, all 200, never 500', async () => {
    const { token, id } = await seedPending('race@example.com');

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        app.inject({ method: 'GET', url: `/verify?token=${token}` }),
      ),
    );

    // No request errored, and every one is a 200.
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);

    // Exactly one saw the flip; the rest saw an already-Active account.
    const verified = responses.filter((r) => r.json().status === 'verified');
    const already = responses.filter((r) => r.json().status === 'already_verified');
    expect(verified).toHaveLength(1);
    expect(already).toHaveLength(responses.length - 1);

    expect(await statusOf(id)).toBe(ACCOUNT_STATUS.active);
  });
});
