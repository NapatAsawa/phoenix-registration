import { ACCOUNT_STATUS } from '../db/schema.js';

/**
 * The Sweep (CONTEXT.md, issue #6): the scheduled pass that expires Pending
 * Accounts whose Confirmation window has elapsed, freeing their email for a new
 * Registration, and clears the token state that verification kept only briefly.
 *
 * Two independent steps:
 *
 *  1. Hard-delete Pending Accounts older than the Pending TTL. "Older than" is
 *     measured from `last_confirmation_sent_at`, not `created_at`, so a Resend
 *     within the window pushes the clock forward and keeps the account alive —
 *     exactly the acceptance criterion. Deleting the row (rather than flagging
 *     it) is what frees the UNIQUE email for a fresh Registration.
 *
 *  2. Null out consumed/expired Verification Tokens. ADR-0002 keeps a token on
 *     its row after use so `verify` can tell "already verified" from "never
 *     existed"; it is kept only *briefly*, and this is the pass that clears it.
 *     Any expired token qualifies — a verified account's spent token, or an
 *     unverified one that lapsed — since an expired token can no longer verify
 *     anything (verify guards on `token_expires_at > now()`). Pending Accounts
 *     that survive step 1 simply drop their dead token; a Resend mints a new one.
 *
 * The two steps are ordered delete-then-clear, but are independent: a row removed
 * in step 1 is already gone before step 2 looks at it. The operation is the seam
 * the scheduled job drives and the integration tests call directly.
 */

/** The slice of a pg pool the Sweep needs — one query method. */
export interface QueryableDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Pending TTL: how long an unconfirmed Registration lives before the Sweep
 * expires it. 72h per the issue. Kept here as a constant (like the 24h token TTL
 * in token.ts) so the one default lives next to the code that applies it; the
 * Sweep accepts an override so tests can drive a short window.
 */
export const PENDING_TTL_MS = 72 * 60 * 60 * 1000;

export interface SweepResult {
  /** Pending Accounts hard-deleted, freeing their email. */
  expiredAccounts: number;
  /** Rows whose consumed/expired token columns were cleared. */
  clearedTokens: number;
}

export async function sweepExpiredPending(
  db: QueryableDb,
  pendingTtlMs: number = PENDING_TTL_MS,
): Promise<SweepResult> {
  // Step 1: expire Pending Accounts past the window. make_interval takes the TTL
  // in seconds; the clock is `last_confirmation_sent_at` so a Resend resets it.
  const expired = await db.query(
    `DELETE FROM accounts
      WHERE status = $1
        AND last_confirmation_sent_at < now() - make_interval(secs => $2)
      RETURNING id`,
    [ACCOUNT_STATUS.pending, pendingTtlMs / 1000],
  );

  // Step 2: clear tokens that are done. An expired token can't verify anything, so
  // clearing it is safe on both verified accounts (consumed) and any survivor
  // whose token merely lapsed.
  const cleared = await db.query(
    `UPDATE accounts
        SET token_hash = NULL, token_expires_at = NULL, updated_at = now()
      WHERE token_hash IS NOT NULL
        AND token_expires_at < now()
      RETURNING id`,
  );

  return { expiredAccounts: expired.rows.length, clearedTokens: cleared.rows.length };
}
