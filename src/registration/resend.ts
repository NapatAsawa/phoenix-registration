import { generateVerificationToken, VERIFICATION_TOKEN_TTL_MS } from './token.js';
import type { EnqueuerLike, PoolLike } from './service.js';
import { ACCOUNT_STATUS } from '../db/schema.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../queue/jobs.js';

/**
 * Resend write side: issue a fresh Confirmation Email for a still-Pending Account,
 * replacing its Verification Token, subject to the Layer-1 throttle (issue #5).
 *
 * Like registration, the token regeneration and the email enqueue commit together
 * on one connection (ADR-0001): the new token_hash is never persisted without a
 * job to deliver it, and no job is queued unless the row actually changed.
 *
 * The throttle is enforced by the database, not a pre-check: one conditional
 * UPDATE that fires only when the row is Pending, under the resend cap, and past
 * the minimum interval. Because the matched row is locked, two concurrent resends
 * can't both pass — the first bumps the count and stamps `last_confirmation_sent_at
 * = now()`, and the second re-reads a row that now fails the interval guard. So the
 * cap and interval hold even under a double-submit. When the UPDATE matches nothing,
 * a single follow-up SELECT classifies why: no such email, an already-Active
 * account, or a Pending account that is currently throttled.
 */

/** Minimum seconds between Confirmation Email sends for one Pending Account. */
export const RESEND_MIN_INTERVAL_SECONDS = 60;
/** Maximum Resends (beyond the initial send) a Pending Account may request. */
export const RESEND_MAX_COUNT = 5;

export interface ResendDeps {
  pool: PoolLike;
  queue: EnqueuerLike;
}

export type ResendResult =
  /** A fresh Confirmation Email was enqueued; the prior token is invalidated. */
  | { ok: true }
  /** No Account exists for this email (→ 404). */
  | { ok: false; reason: 'not-found' }
  /** The Account exists but is not Pending, e.g. already Active (→ 409). */
  | { ok: false; reason: 'not-pending' }
  /** Pending, but over the interval or the resend cap (→ 429). */
  | { ok: false; reason: 'throttled' };

export async function resendConfirmation(deps: ResendDeps, email: string): Promise<ResendResult> {
  const { token, tokenHash } = generateVerificationToken();
  const tokenExpiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

  const client = await deps.pool.connect();
  try {
    try {
      await client.query('BEGIN');

      // The one throttle-and-regenerate step. All three guards must hold for the
      // resend to happen; the row lock makes the count/interval bump atomic.
      const updated = await client.query(
        `UPDATE accounts
            SET token_hash = $2,
                token_expires_at = $3,
                resend_count = resend_count + 1,
                last_confirmation_sent_at = now(),
                updated_at = now()
          WHERE email = $1
            AND status = $4
            AND resend_count < $5
            AND last_confirmation_sent_at <= now() - make_interval(secs => $6)
          RETURNING id`,
        [
          email,
          tokenHash,
          tokenExpiresAt,
          ACCOUNT_STATUS.pending,
          RESEND_MAX_COUNT,
          RESEND_MIN_INTERVAL_SECONDS,
        ],
      );

      if (updated.rows.length > 0) {
        const accountId = updated.rows[0].id as string;
        const job: ConfirmationEmailJob = { accountId, token };
        await deps.queue.sendInTransaction(CONFIRMATION_EMAIL_QUEUE, job, client);
        await client.query('COMMIT');
        return { ok: true };
      }

      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }

    // Zero rows updated: the account isn't an eligible Pending target. One SELECT
    // tells the three cases apart (runs outside the rolled-back transaction).
    const existing = await client.query(`SELECT status FROM accounts WHERE email = $1`, [email]);
    const row = existing.rows[0];
    if (!row) return { ok: false, reason: 'not-found' };
    if (row.status !== ACCOUNT_STATUS.pending) return { ok: false, reason: 'not-pending' };
    return { ok: false, reason: 'throttled' };
  } finally {
    client.release();
  }
}
