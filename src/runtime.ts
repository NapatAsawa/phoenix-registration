import type { Pool } from 'pg';
import type { ReadinessChecks } from './app.js';
import { Queue } from './queue/queue.js';

/**
 * The shared runtime both entrypoints build over (ADR-0003): a Postgres pool and
 * a started job queue. Neither the API nor the worker owns state the other needs;
 * they compose the same pieces and differ only in what they expose.
 */
export interface Runtime {
  pool: Pool;
  queue: Queue;
}

/** Readiness probes derived from a runtime, for the API's `/readyz`. */
export function readinessChecks(runtime: Runtime): ReadinessChecks {
  return {
    pingDb: async () => {
      await runtime.pool.query('SELECT 1');
    },
    isQueueStarted: () => runtime.queue.isStarted(),
  };
}
