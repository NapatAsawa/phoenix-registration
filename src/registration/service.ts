import type { PoolClient } from 'pg';
import { hashPassword } from './password.js';
import { resendConfirmation } from './resend.js';
import { mintVerificationToken } from './token.js';
import type { RegistrationInput } from './validation.js';
import { ACCOUNT_STATUS } from '../db/schema.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../queue/jobs.js';

/**
 * Registration write side. Two responsibilities, in order:
 *
 *  1. The atomic create. {@link insertPendingAccount} checks out a single
 *     connection and runs both the account INSERT and the pg-boss enqueue on it
 *     between BEGIN and COMMIT, so ADR-0001's guarantee holds literally: an
 *     account never exists without a pending email job, and a job never exists
 *     for an account that failed to persist. The Verification Token is minted
 *     here (sha256 + 24h expiry stored on the row, plaintext handed to the job),
 *     so it is fixed the moment the account exists and every at-least-once
 *     delivery emits the same link (ADR-0002).
 *
 *  2. Collision handling (issue #5). When the email is already taken, the row is
 *     either Active — a genuine 409 — or still Pending, in which case this
 *     registration is a Resend and is delegated to {@link resendConfirmation}
 *     (which owns the Layer-1 throttle). The UNIQUE constraint, not a pre-check,
 *     is what tells us the email is taken.
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
  const inserted = await insertPendingAccount(deps, input);
  if (inserted.status === 'created') {
    return { ok: true, outcome: 'created', accountId: inserted.accountId };
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

type InsertOutcome = { status: 'created'; accountId: string } | { status: 'duplicate' };

/**
 * The atomic create half of registration: INSERT the Pending Account and enqueue
 * its Confirmation Email on one connection, or report `duplicate` if the email is
 * already taken (the UNIQUE constraint is the source of truth). Kept separate so
 * the single connection is released under one `finally` before the Resend path,
 * if any, opens its own.
 */
async function insertPendingAccount(
  deps: RegisterDeps,
  input: RegistrationInput,
): Promise<InsertOutcome> {
  // Hash before opening the transaction: argon2 is deliberately slow and there is
  // no reason to hold a connection (and a row lock) while it runs.
  const passwordHash = await hashPassword(input.password);
  const { token, tokenHash, expiresAt } = mintVerificationToken();

  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      `INSERT INTO accounts (email, password_hash, status, token_hash, token_expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [input.email, passwordHash, ACCOUNT_STATUS.pending, tokenHash, expiresAt],
    );
    const accountId = inserted.rows[0].id as string;

    const job: ConfirmationEmailJob = { accountId, token };
    await deps.queue.sendInTransaction(CONFIRMATION_EMAIL_QUEUE, job, client);

    await client.query('COMMIT');
    return { status: 'created', accountId };
  } catch (err) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(err)) return { status: 'duplicate' };
    throw err;
  } finally {
    client.release();
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err &&
    (err as { code?: string }).code === UNIQUE_VIOLATION;
}
