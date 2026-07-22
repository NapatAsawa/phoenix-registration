import type { Queue } from './queue.js';
import {
  CONFIRMATION_EMAIL_QUEUE,
  CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
  CONFIRMATION_EMAIL_RETRY_LIMIT,
} from './jobs.js';

/**
 * Ensure the Confirmation Email queue and its dead-letter queue exist, wired with
 * the retry/dead-letter policy (issue #7, ADR-0002). Both entrypoints call this on
 * boot — the API so its transactionally-enqueued jobs inherit the policy, the
 * worker so it consumes the same queues. Keeping it in one place stops the two
 * from drifting on the retry limit or the dead-letter target.
 *
 * The dead-letter queue is created first: pg-boss's queue table has a foreign key
 * from a queue's `deadLetter` to an existing queue, so the target must exist before
 * the main queue references it.
 */
export async function setupConfirmationEmailQueues(queue: Queue): Promise<void> {
  await queue.createQueue(CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE);
  await queue.createQueue(CONFIRMATION_EMAIL_QUEUE, {
    retryLimit: CONFIRMATION_EMAIL_RETRY_LIMIT,
    retryBackoff: true,
    deadLetter: CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
  });
}
