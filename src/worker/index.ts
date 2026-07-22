import { loadConfig } from '../config.js';
import { createPool } from '../db/client.js';
import { Queue } from '../queue/queue.js';
import {
  CONFIRMATION_EMAIL_QUEUE,
  SWEEP_QUEUE,
  SWEEP_CRON,
  type ConfirmationEmailJob,
  type SweepJob,
} from '../queue/jobs.js';
import { ConsoleEmailSender } from '../email/sender.js';
import { makeConfirmationEmailHandler } from '../email/confirmation-handler.js';
import { sweepExpiredPending } from '../sweep/service.js';

/**
 * Worker entrypoint: runs background jobs off the pg-boss queue. It consumes the
 * Confirmation Email queue, minting each account's Verification Token and sending
 * the email, and runs the hourly Sweep of expired Pending accounts (issue #6). It
 * does not depend on the API being up (ADR-0003).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const queue = new Queue(config.databaseUrl);
  await queue.start();
  await queue.createQueue(CONFIRMATION_EMAIL_QUEUE);
  await queue.createQueue(SWEEP_QUEUE);

  const handleConfirmationEmail = makeConfirmationEmailHandler({
    db: pool,
    emailSender: new ConsoleEmailSender(),
    publicBaseUrl: config.publicBaseUrl,
  });
  await queue.work<ConfirmationEmailJob>(CONFIRMATION_EMAIL_QUEUE, handleConfirmationEmail);

  // The Sweep runs itself off a cron-scheduled job (ADR-0001: pg-boss owns the
  // schedule, so it survives restarts and one firing runs per hour across all
  // worker replicas). The handler just drives the operation against Postgres.
  await queue.work<SweepJob>(SWEEP_QUEUE, async () => {
    const result = await sweepExpiredPending(pool);
    console.log(
      `worker: sweep expired ${result.expiredAccounts} pending account(s), cleared ${result.clearedTokens} token(s)`,
    );
  });
  await queue.schedule(SWEEP_QUEUE, SWEEP_CRON);

  console.log('worker: queue started, consuming confirmation-email + sweep jobs');

  const shutdown = async (): Promise<void> => {
    await queue.stop();
    await pool.end();
  };
  process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
