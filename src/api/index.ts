import { loadConfig } from '../config.js';
import { createPool } from '../db/client.js';
import { Queue } from '../queue/queue.js';
import { buildApp } from '../app.js';
import { readinessChecks } from '../runtime.js';

/**
 * API entrypoint: serves the HTTP surface. It starts its own pg-boss instance so
 * it can enqueue jobs transactionally with account writes; it does not depend on
 * the worker being up (ADR-0003).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const queue = new Queue(config.databaseUrl);
  await queue.start();

  const app = buildApp({
    checks: readinessChecks({ pool, queue }),
    logger: true,
  });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await queue.stop();
    await pool.end();
  };
  process.on('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().finally(() => process.exit(0)));

  await app.listen({ host: '0.0.0.0', port: config.apiPort });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
