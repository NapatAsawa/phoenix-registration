import type { Pool } from 'pg';
import type { Queue } from '../queue/queue.js';
import {
  CONFIRMATION_EMAIL_QUEUE,
  CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE,
  SWEEP_QUEUE,
  SWEEP_CRON,
  type ConfirmationEmailJob,
  type SweepJob,
} from '../queue/jobs.js';
import { setupConfirmationEmailQueues } from '../queue/setup.js';
import { makeConfirmationEmailHandler } from '../email/confirmation-handler.js';
import type { EmailSender } from '../email/sender.js';
import { sweepExpiredPending } from '../sweep/service.js';
import { DOMAIN_EVENT, type Logger } from '../observability/log.js';
import type { JobContext } from '../queue/queue.js';

/**
 * The worker composition root, extracted from the entrypoint so it can be driven
 * in an integration test with a capturing logger and a throwing sender — which is
 * how the retry-then-dead-letter path and the domain-event lines get exercised
 * (issue #7). The entrypoint (index.ts) supplies the real deps and owns process
 * lifecycle; this function only wires queues to handlers.
 *
 * It assumes `queue` is already started. Every handler binds a per-job child logger
 * whose `reqId` is the pg-boss job id, so each background line traces to its job.
 */
export interface WorkerDeps {
  pool: Pool;
  queue: Queue;
  emailSender: EmailSender;
  logger: Logger;
  publicBaseUrl: string;
  pendingTtlMs: number;
}

export async function startWorker(deps: WorkerDeps): Promise<void> {
  const { pool, queue, logger } = deps;

  // Every worker line traces to its job: bind the pg-boss job id as `reqId`, plus
  // the queue it came off, on a per-job child logger.
  const perJobLog = (ctx: JobContext, queueName: string): Logger =>
    logger.child({ reqId: ctx.jobId, queue: queueName });

  await setupConfirmationEmailQueues(queue);
  await queue.createQueue(SWEEP_QUEUE);

  // Confirmation Email: deliver for a still-Pending account, then log the send.
  // The handler itself throws on a send failure, which is what drives pg-boss's
  // retry/dead-letter machinery (ADR-0002); nothing is caught here.
  const handleConfirmationEmail = makeConfirmationEmailHandler({
    db: pool,
    emailSender: deps.emailSender,
    publicBaseUrl: deps.publicBaseUrl,
  });
  await queue.work<ConfirmationEmailJob>(CONFIRMATION_EMAIL_QUEUE, async (data, ctx) => {
    const log = perJobLog(ctx, CONFIRMATION_EMAIL_QUEUE);
    const result = await handleConfirmationEmail(data);
    if (result.sent) {
      log.info(
        { event: DOMAIN_EVENT.confirmationEmailSent, accountId: result.accountId, email: result.email },
        'confirmation email sent',
      );
    }
  });

  // Dead-letter consumer: a Confirmation Email that exhausted its retries lands
  // here. We only log it at error — the Account is left Pending so the person can
  // still trigger a resend (ADR-0002); the payload is the original job's data.
  await queue.work<ConfirmationEmailJob>(CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE, async (data, ctx) => {
    const log = perJobLog(ctx, CONFIRMATION_EMAIL_DEAD_LETTER_QUEUE);
    log.error(
      { event: DOMAIN_EVENT.confirmationEmailDeadLettered, accountId: data.accountId },
      'confirmation email dead-lettered after retries; account left pending',
    );
  });

  // The Sweep runs off a cron-scheduled job (ADR-0001: pg-boss owns the schedule,
  // so one firing runs per hour across all worker replicas). One account.expired
  // line per removed account keeps the expiry traceable.
  await queue.work<SweepJob>(SWEEP_QUEUE, async (_data, ctx) => {
    const log = perJobLog(ctx, SWEEP_QUEUE);
    const result = await sweepExpiredPending(pool, deps.pendingTtlMs);
    for (const accountId of result.expiredAccountIds) {
      log.info({ event: DOMAIN_EVENT.accountExpired, accountId }, 'pending account expired by sweep');
    }
    log.info(
      { sweepExpired: result.expiredAccounts, sweepClearedTokens: result.clearedTokens },
      'sweep complete',
    );
  });
  await queue.schedule(SWEEP_QUEUE, SWEEP_CRON);
}
