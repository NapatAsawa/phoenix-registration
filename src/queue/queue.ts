import PgBoss from 'pg-boss';
import type { PoolClient } from 'pg';

/** Per-job context handed to a {@link JobHandler} alongside the payload. */
export interface JobContext {
  /** pg-boss job id; used as the per-job request id on worker log lines (issue #7). */
  jobId: string;
}

/**
 * Handler for jobs on a queue; receives one job's payload and its context. Any
 * resolved value is ignored (pg-boss keeps it as the job's output), so a handler
 * may return a result for its own logging without the queue caring.
 */
export type JobHandler<T extends object> = (data: T, ctx: JobContext) => Promise<unknown>;

/**
 * Retry and dead-letter policy for a queue. Set on the queue definition rather than
 * at each send, so every enqueue inherits it (pg-boss resolves send → queue → global
 * defaults). `deadLetter` names the queue an exhausted job is moved to.
 */
export interface QueueOptions {
  retryLimit?: number;
  retryBackoff?: boolean;
  deadLetter?: string;
}

/**
 * Thin wrapper over pg-boss that tracks started state so readiness checks can
 * report whether the queue is up. pg-boss stores its jobs in the same Postgres
 * database as the write model (ADR-0001), which is what lets the Confirmation
 * Email be enqueued in the same transaction that creates the account — see
 * {@link sendInTransaction}.
 */
export class Queue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(databaseUrl: string) {
    this.boss = new PgBoss({ connectionString: databaseUrl });
    // pg-boss surfaces background failures via 'error'; swallowing them would
    // crash the process on an unhandled emitter error.
    this.boss.on('error', () => {
      /* logged by callers wiring their own handler; kept non-fatal here */
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
    this.started = true;
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true });
    this.started = false;
  }

  isStarted(): boolean {
    return this.started;
  }

  /**
   * Ensure a queue exists, optionally with a retry/dead-letter {@link QueueOptions}
   * policy. Idempotent; safe to call from every entrypoint on boot. Because pg-boss
   * creates the queue on first call and no-ops after, the policy is fixed by whoever
   * creates it first — which is what lets a test pre-create the queue with a fast
   * retry policy to exercise the dead-letter path.
   */
  async createQueue(name: string, options: QueueOptions = {}): Promise<void> {
    await this.boss.createQueue(name, { name, ...options });
  }

  /**
   * Enqueue a job on the caller's open transaction. Routing pg-boss's INSERT
   * through `client` (instead of pg-boss's own pool) means the job row and
   * whatever else the caller wrote share one atomic COMMIT: both land or neither
   * does (ADR-0001). The retry/dead-letter policy that makes at-least-once delivery
   * (ADR-0002) safe lives on the queue definition (see {@link createQueue}), so the
   * job inherits it here without this send site restating it.
   */
  async sendInTransaction(name: string, data: object, client: PoolClient): Promise<void> {
    await this.boss.send(name, data, {
      db: { executeSql: (text, values) => client.query(text, values) },
    });
  }

  /**
   * Schedule a recurring job on a queue via cron. pg-boss enqueues one job per
   * firing; a registered {@link work} consumer runs it. Idempotent on the
   * (queue, cron) pair, so it's safe to call on every worker boot.
   */
  async schedule(name: string, cron: string, data: object = {}): Promise<void> {
    await this.boss.schedule(name, cron, data);
  }

  /** Register a consumer for a queue. Errors thrown by `handler` trigger pg-boss retries. */
  async work<T extends object>(name: string, handler: JobHandler<T>): Promise<void> {
    await this.boss.work<T>(name, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data, { jobId: job.id });
      }
    });
  }
}
