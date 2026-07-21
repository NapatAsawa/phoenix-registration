import { loadConfig } from '../config.js';
import { createPool } from '../db/client.js';
import { Queue } from '../queue/queue.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../queue/jobs.js';
import { ConsoleEmailSender } from '../email/sender.js';
import { makeConfirmationEmailHandler } from '../email/confirmation-handler.js';

/**
 * Worker entrypoint: runs background jobs off the pg-boss queue. It consumes the
 * Confirmation Email queue, minting each account's Verification Token and sending
 * the email. It does not depend on the API being up (ADR-0003).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const queue = new Queue(config.databaseUrl);
  await queue.start();
  await queue.createQueue(CONFIRMATION_EMAIL_QUEUE);

  const handleConfirmationEmail = makeConfirmationEmailHandler({
    db: pool,
    emailSender: new ConsoleEmailSender(),
    publicBaseUrl: config.publicBaseUrl,
  });
  await queue.work<ConfirmationEmailJob>(CONFIRMATION_EMAIL_QUEUE, handleConfirmationEmail);

  console.log('worker: queue started, consuming confirmation-email jobs');

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
