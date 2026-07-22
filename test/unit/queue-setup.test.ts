import { describe, it, expect } from 'vitest';
import {
  setupConfirmationEmailQueues,
  type QueueCreator,
} from '../../src/queue/setup.js';
import type { QueueOptions } from '../../src/queue/queue.js';
import {
  CONFIRMATION_EMAIL_QUEUE,
  CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
} from '../../src/queue/jobs.js';

/**
 * Pin the *production* retry/dead-letter policy the acceptance criteria name:
 * "retries with exponential backoff, up to 5 attempts, then dead-letters" (issue
 * #7). The integration test runs a deliberately fast policy, so this is where the
 * real numbers are asserted.
 */
type CreateCall = { name: string; options?: QueueOptions };

function recordingQueue(): { queue: QueueCreator; calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  return {
    calls,
    queue: {
      async createQueue(name, options) {
        calls.push({ name, options });
      },
    },
  };
}

describe('setupConfirmationEmailQueues', () => {
  it('wires the confirmation queue with retryLimit 5, exponential backoff, and the dead-letter target', async () => {
    const { queue, calls } = recordingQueue();

    await setupConfirmationEmailQueues(queue);

    const main = calls.find((c) => c.name === CONFIRMATION_EMAIL_QUEUE);
    expect(main?.options).toEqual({
      retryLimit: 5,
      retryBackoff: true,
      deadLetter: CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
    });
  });

  it('creates the dead-letter queue before the main queue references it', async () => {
    const { queue, calls } = recordingQueue();

    await setupConfirmationEmailQueues(queue);

    const dlqIndex = calls.findIndex((c) => c.name === CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE);
    const mainIndex = calls.findIndex((c) => c.name === CONFIRMATION_EMAIL_QUEUE);
    expect(dlqIndex).toBeGreaterThanOrEqual(0);
    expect(dlqIndex).toBeLessThan(mainIndex);
  });

  it('lets a caller override the policy (fast retries for tests) while keeping the rest', async () => {
    const { queue, calls } = recordingQueue();

    await setupConfirmationEmailQueues(queue, { retryLimit: 1, retryBackoff: false });

    const main = calls.find((c) => c.name === CONFIRMATION_EMAIL_QUEUE);
    expect(main?.options).toMatchObject({
      retryLimit: 1,
      retryBackoff: false,
      deadLetter: CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
    });
  });
});
