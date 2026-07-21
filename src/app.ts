import Fastify, { type FastifyInstance } from 'fastify';

/**
 * Readiness dependencies the app probes on `GET /readyz`. Passing these as
 * functions keeps `buildApp` decoupled from concrete Postgres / pg-boss objects,
 * so the health surface can be tested with fakes and driven with real
 * infrastructure in integration tests.
 */
export interface ReadinessChecks {
  /** Resolves when the database is reachable; rejects otherwise. */
  pingDb: () => Promise<void>;
  /** True when the job queue has started. */
  isQueueStarted: () => boolean;
}

export interface BuildAppOptions {
  checks: ReadinessChecks;
  logger?: boolean;
}

/**
 * Builds the Fastify app exposing the operational health surface.
 *
 * - `GET /healthz` (liveness): always 200 while the process is up.
 * - `GET /readyz` (readiness): 200 when the DB is reachable and the queue is
 *   started; 503 otherwise.
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const { checks } = options;

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const details: { db: boolean; queue: boolean } = { db: false, queue: false };

    try {
      await checks.pingDb();
      details.db = true;
    } catch {
      details.db = false;
    }

    details.queue = checks.isQueueStarted();

    if (details.db && details.queue) {
      return { status: 'ready', ...details };
    }
    return reply.code(503).send({ status: 'not-ready', ...details });
  });

  return app;
}
