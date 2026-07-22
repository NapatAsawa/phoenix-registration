import type { QueueOptions } from './queue.js';
import {
  CONFIRMATION_EMAIL_QUEUE,
  CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
  CONFIRMATION_EMAIL_RETRY_LIMIT,
} from './jobs.js';

/** Just the slice of {@link Queue} this setup needs — creating queues. */
export interface QueueCreator {
  createQueue(name: string, options?: QueueOptions): Promise<void>;
}

/** The production retry/dead-letter policy for the Confirmation Email queue. */
export const CONFIRMATION_EMAIL_QUEUE_POLICY: QueueOptions = {
  retryLimit: CONFIRMATION_EMAIL_RETRY_LIMIT,
  retryBackoff: true,
  deadLetter: CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
};

/**
 * Ensure the Confirmation Email queue and its dead-letter queue exist, wired with
 * the retry/dead-letter policy (issue #7, ADR-0002). Both entrypoints call this on
 * boot — the API so its transactionally-enqueued jobs inherit the policy, the
 * worker so it consumes the same queues. Keeping it in one place stops the two
 * from drifting on the retry limit or the dead-letter target.
 *
 * `policyOverrides` exists for tests: because pg-boss's createQueue is create-once,
 * a test that calls this with a fast retry policy before the worker boots pins that
 * policy, letting the dead-letter path be exercised in seconds. Production passes
 * nothing and gets {@link CONFIRMATION_EMAIL_QUEUE_POLICY}.
 *
 * The dead-letter queue is created first: pg-boss's queue table has a foreign key
 * from a queue's `deadLetter` to an existing queue, so the target must exist before
 * the main queue references it.
 */
export async function setupConfirmationEmailQueues(
  queue: QueueCreator,
  policyOverrides: QueueOptions = {},
): Promise<void> {
  await queue.createQueue(CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE);
  await queue.createQueue(CONFIRMATION_EMAIL_QUEUE, {
    ...CONFIRMATION_EMAIL_QUEUE_POLICY,
    ...policyOverrides,
  });
}
