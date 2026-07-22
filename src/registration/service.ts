import type { PoolClient } from 'pg';
import { hashPassword } from './password.js';
import { resendConfirmation } from './resend.js';
import { generateVerificationToken, VERIFICATION_TOKEN_TTL_MS } from './token.js';
import type { RegistrationInput } from './validation.js';
import { ACCOUNT_STATUS } from '../db/schema.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../queue/jobs.js';

/**
 * Registration write side: create the Pending Account and enqueue its
 * Confirmation Email in one atomic step.
 *
 * The whole point of this module is the transaction. It checks out a single
 * connection, and both the account INSERT and the pg-boss enqueue run on that
 * connection between BEGIN and COMMIT, so ADR-0001's guarantee holds literally:
 * an account never exists without a pending email job, and a job never exists
 * for an account that failed to persist.
 *
 * The Verification Token is minted here too: its sha256 and 24h expiry are
 * written onto the account row, and the plaintext is handed to the job. Storing
 * the hash atomically with the account means the token is fixed the moment the
 * account exists, so every (at-least-once) delivery of the job emits the same
 * link (ADR-0002). The plaintext is never persisted on the account.
 */

/** Just the slice of `pg.Pool` the service needs — a connection to run a tx on. */
export interface PoolLike {
  connect(): Promise<PoolClient>;
}

/** Just the slice of {@link Queue} the service needs — a transaction-aware enqueue. */
export interface EnqueuerLike {
  sendInTransaction(name: string, data: object, client: PoolClient): Promise<void>;
}

export interface RegisterDeps {
  pool: PoolLike;
  queue: EnqueuerLike;
}

export type RegisterResult =
  /** A new Pending Account was created and its Confirmation Email queued. */
  | { ok: true; outcome: 'created'; accountId: string }
  /**
   * The email already belonged to a still-Pending Account, so this registration
   * was handled as a Resend (issue #5): a fresh Confirmation Email was queued.
   */
  | { ok: true; outcome: 'resent' }
  // Email already registered to an Active Account. The UNIQUE constraint is the
  // source of truth, so the collision is reported by the database under
  // concurrency, not a pre-check.
  | { ok: false; reason: 'duplicate-email' }
  /** The Pending Account is currently over the Resend interval or cap (→ 429). */
  | { ok: false; reason: 'throttled' };

const UNIQUE_VIOLATION = '23505';

export async function registerAccount(
  deps: RegisterDeps,
  input: RegistrationInput,
): Promise<RegisterResult> {
  // Hash before opening the transaction: argon2 is deliberately slow and there is
  // no reason to hold a connection (and a row lock) while it runs.
  const passwordHash = await hashPassword(input.password);
  const { token, tokenHash } = generateVerificationToken();
  const tokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO accounts (email, password_hash, status, token_hash, token_expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.email, passwordHash, ACCOUNT_STATUS.pending, tokenHash, tokenExpiresAt],
    );
    const accountId = inserted.rows[0].id as string;

    const job: ConfirmationEmailJob = { accountId, token };
    await deps.queue.sendInTransaction(CONFIRMATION_EMAIL_QUEUE, job, client);

    await client.query('COMMIT');
    client.release();
    return { ok: true, outcome: 'created', accountId };
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    if (!isUniqueViolation(err)) throw err;
    // Fell through only on a duplicate email. Release first (above) so we don't
    // hold two connections while the Resend path opens its own.
  }

  // The email is taken. If the existing Account is still Pending this is a Resend;
  // if it's Active it's a genuine collision (409). Reuse the throttled Resend path
  // so the interval/cap apply to the registration entry point too (issue #5).
  const resend = await resendConfirmation(deps, input.email);
  if (resend.ok) return { ok: true, outcome: 'resent' };
  switch (resend.reason) {
    case 'not-pending':
      return { ok: false, reason: 'duplicate-email' };
    case 'throttled':
      return { ok: false, reason: 'throttled' };
    case 'not-found':
      // The row vanished between the UNIQUE violation and the Resend (a Sweep in
      // the gap, issue #6). Vanishingly rare; report taken and let the client retry.
      return { ok: false, reason: 'duplicate-email' };
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    (err as { code?: string }).code === UNIQUE_VIOLATION;
}
