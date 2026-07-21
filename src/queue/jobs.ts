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
