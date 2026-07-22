/**
 * The queue contract shared by the API (which enqueues) and the worker (which
 * consumes). Naming the queue and its payload in one place keeps producer and
 * consumer from drifting.
 */

/** Queue that carries "send this account its Confirmation Email" jobs. */
export const CONFIRMATION_EMAIL_QUEUE = 'confirmation-email';

/**
 * Dead-letter queue for Confirmation Email jobs. When a send exhausts its retries
 * pg-boss moves the job here (ADR-0002); the worker consumes this queue to log the
 * exhaustion at error. The Account is left Pending, so the person can still resend.
 */
export const CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE = 'confirmation-email-dead-letter';

/**
 * Retry policy for the Confirmation Email queue: up to 5 attempts with exponential
 * backoff, then dead-letter (issue #7, ADR-0002). Set once on the queue definition
 * (see setupConfirmationEmailQueues) so every enqueue — from registration or a
 * resend — inherits it without repeating the policy at each send site.
 */
export const CONFIRMATION_EMAIL_RETRY_LIMIT = 5;

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
