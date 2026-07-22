import { loadConfig } from '../config.js';
import { createPool } from '../db/client.js';
import { Queue } from '../queue/queue.js';
import { setupConfirmationEmailQueues } from '../queue/setup.js';
import { createLogger } from '../observability/log.js';
import { buildApp } from '../app.js';
import { readinessChecks } from '../runtime.js';
import { registerAccount } from '../registration/service.js';
import { resendConfirmation } from '../registration/resend.js';
import { verifyToken } from '../verification/service.js';
import type { RegistrationInput } from '../registration/validation.js';

/**
 * API entrypoint: serves the HTTP surface. It starts its own pg-boss instance so
 * it can enqueue jobs transactionally with account writes; it does not depend on
 * the worker being up (ADR-0003).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });
  const pool = createPool(config.databaseUrl);
  const queue = new Queue(config.databaseUrl);
  await queue.start();
  // Both entrypoints ensure the queue (and its dead-letter queue) exist on boot,
  // with the retry policy; creating them is idempotent.
  await setupConfirmationEmailQueues(queue);

  const app = buildApp({
    checks: readinessChecks({ pool, queue }),
    loggerInstance: logger,
    registration: {
      register: (input: RegistrationInput) => registerAccount({ pool, queue }, input),
    },
    resend: {
      resend: (email: string) => resendConfirmation({ pool, queue }, email),
    },
    verification: {
      verify: (token: string) => verifyToken(pool, token),
    },
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
