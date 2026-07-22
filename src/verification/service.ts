import { hashToken } from '../registration/token.js';
import { ACCOUNT_STATUS } from '../db/schema.js';

/**
 * Verification write side: flip a Pending Account to Active by its Verification
 * Token, idempotently and safely under concurrency (issue #4, ADR-0002).
 *
 * The whole mechanism is a single atomic conditional UPDATE guarded by
 * `status = 'pending'`. Postgres row locking means that when the same token is
 * followed twice at once (double-click, prefetch, mail scanner), only one UPDATE
 * can match the still-Pending row; the other re-reads after it commits, sees
 * `status = 'active'`, and matches nothing. So exactly one activation happens and
 * neither request errors. A follow-up SELECT then tells the two zero-row cases
 * apart: an account already Active (idempotent hit) vs. an expired or unknown
 * token.
 *
 * The token is looked up by its sha256, never its plaintext, matching how it was
 * stored at registration.
 */

/** The slice of a pg pool the service needs — one query method. */
export interface QueryableDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type VerifyOutcome =
  /** First valid follow of the link: the account was Pending and is now Active. */
  | { status: 'verified' }
  /** The account was already Active: a repeat/concurrent follow. Harmless. */
  | { status: 'already-verified' }
  /** Token expired or never existed: nothing to activate. */
  | { status: 'invalid' };

export async function verifyToken(db: QueryableDb, token: string): Promise<VerifyOutcome> {
  const tokenHash = hashToken(token);

  // The one atomic step. `status = 'pending'` is both the idempotency guard (an
  // already-Active row can't match again) and the concurrency guard (only one
  // racer can flip the single Pending row).
  const activated = await db.query(
    `UPDATE accounts
       SET status = $1, updated_at = now()
     WHERE token_hash = $2 AND status = $3 AND token_expires_at > now()
     RETURNING id`,
    [ACCOUNT_STATUS.active, tokenHash, ACCOUNT_STATUS.pending],
  );
  if (activated.rows.length > 0) return { status: 'verified' };

  // Zero rows updated. Either the account is already Active (idempotent hit) or
  // the token is expired/unknown. The consumed token row is kept briefly (not
  // hard-deleted on use, ADR-0002) precisely so this distinction is possible.
  const existing = await db.query(`SELECT status FROM accounts WHERE token_hash = $1`, [tokenHash]);
  const row = existing.rows[0];
  if (row?.status === ACCOUNT_STATUS.active) return { status: 'already-verified' };
  return { status: 'invalid' };
}
