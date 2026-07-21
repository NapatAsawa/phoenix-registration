import { buildConfirmationEmail, buildVerificationUrl } from './confirmation.js';
import type { EmailSender } from './sender.js';
import type { ConfirmationEmailJob } from '../queue/jobs.js';
import { ACCOUNT_STATUS } from '../db/schema.js';

/**
 * The worker seam for the Confirmation Email job: for a still-Pending account,
 * build the confirmation link from the token carried on the job and send it.
 *
 * The token is minted and its sha256 stored when the account is created (see
 * registerAccount), not here — so this handler holds no secret state and every
 * at-least-once retry re-sends the identical link (ADR-0002). It only reads the
 * email address, and skips an account that is no longer Pending (already
 * verified, or swept): that job has nothing left to do.
 */

/** The slice of a pg pool the handler needs. */
export interface QueryableDb {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ConfirmationEmailDeps {
  db: QueryableDb;
  emailSender: EmailSender;
  publicBaseUrl: string;
}

export function makeConfirmationEmailHandler(
  deps: ConfirmationEmailDeps,
): (job: ConfirmationEmailJob) => Promise<void> {
  return async ({ accountId, token }) => {
    const found = await deps.db.query(
      `SELECT email FROM accounts WHERE id = $1 AND status = $2`,
      [accountId, ACCOUNT_STATUS.pending],
    );
    const row = found.rows[0];
    if (!row) return; // not Pending (verified/expired) — nothing to send

    const email = row.email as string;
    const verificationUrl = buildVerificationUrl(deps.publicBaseUrl, token);
    await deps.emailSender.send(buildConfirmationEmail(email, verificationUrl));
  };
}
