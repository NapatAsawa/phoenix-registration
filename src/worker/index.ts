import { loadConfig } from '../config.js';
import { Queue } from '../queue/queue.js';

/**
 * Worker entrypoint: runs background jobs off the pg-boss queue. In this walking
 * skeleton it only boots the queue and stays alive; the confirmation-email and
 * sweep handlers are registered by later issues. It does not depend on the API
 * being up (ADR-0003).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const queue = new Queue(config.databaseUrl);
  await queue.start();

  console.log('worker: queue started, awaiting jobs');

  const shutdown = async (): Promise<void> => {
    await queue.stop();
  };
  process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
