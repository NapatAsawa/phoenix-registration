import { loadConfig } from '../config.js';
import { createPool } from '../db/client.js';
import { Queue } from '../queue/queue.js';
import { createEmailSender } from '../email/transport.js';
import { createLogger } from '../observability/log.js';
import { startWorker } from './run.js';

/**
 * Worker entrypoint: runs background jobs off the pg-boss queue. It consumes the
 * Confirmation Email queue (and its dead-letter queue) and runs the hourly Sweep,
 * all wired by {@link startWorker}. It does not depend on the API being up
 * (ADR-0003). This file only builds the real dependencies and owns process
 * lifecycle; the wiring lives in run.ts so it can be tested.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const queue = new Queue(config.databaseUrl);
  await queue.start();

  await startWorker({
    pool,
    queue,
    emailSender: createEmailSender({ transport: config.emailTransport, smtpUrl: config.smtpUrl }),
    logger,
    publicBaseUrl: config.publicBaseUrl,
    pendingTtlMs: config.pendingTtlMs,
  });

  logger.info(
    { emailTransport: config.emailTransport },
    'worker: queue started, consuming confirmation-email + sweep jobs',
  );

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
