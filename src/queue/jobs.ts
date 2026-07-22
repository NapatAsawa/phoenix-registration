/**
 * The queue contract shared by the API (which enqueues) and the worker (which
 * consumes). Naming the queue and its payload in one place keeps producer and
 * consumer from drifting.
 */

/** Queue that carries "send this account its Confirmation Email" jobs. */
export const CONFIRMATION_EMAIL_QUEUE = 'confirmation-email';

/**
 * Payload for a Confirmation Email job. The plaintext Verification Token rides
 * here (only its sha256 is stored on the account) so a retry re-sends the *same*
 * link — the same job carries the same token, satisfying ADR-0002's requirement
 * that the token be stable across at-least-once delivery.
 */
export interface ConfirmationEmailJob {
  accountId: string;
  token: string;
}

/** Queue that carries the periodic Sweep of expired Pending accounts (issue #6). */
export const SWEEP_QUEUE = 'sweep-expired-pending';

/**
 * Cron for the Sweep: top of every hour. The Sweep is idempotent and TTL-based,
 * so the exact firing time doesn't matter — hourly is frequent enough to free
 * emails promptly without churning the table.
 */
export const SWEEP_CRON = '0 * * * *';

/** The Sweep job carries no payload; the operation reads the whole table. */
export type SweepJob = Record<string, never>;
