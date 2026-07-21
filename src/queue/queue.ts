import PgBoss from 'pg-boss';
import type { PoolClient } from 'pg';

/** Handler for jobs on a queue; receives one job at a time. */
export type JobHandler<T extends object> = (data: T) => Promise<void>;

/**
 * How long a finished job's row survives before pg-boss deletes it. A finished
 * Confirmation Email job carries the plaintext Verification Token in its payload
 * (so retries re-emit the same link, ADR-0002), so its row is sensitive at rest.
 * pg-boss's defaults keep finished jobs ~7.5 days (12h in `job`, then 7 days in
 * `archive`) — far longer than the token's 24h life, leaving a reversible secret
 * lying around long after it's useful. These knobs shrink that window to ~an
 * hour: a DB/backup read then yields at most a handful of live tokens, and the
 * durable `accounts` row never holds the plaintext at all.
 */
const ARCHIVE_FINISHED_AFTER_SECONDS = 600; // move out of `job` 10 min after finish
const DELETE_ARCHIVED_AFTER_HOURS = 1; // then purge from `archive` an hour later

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
    this.boss = new PgBoss({
      connectionString: databaseUrl,
      // Keep sensitive finished-job payloads (see the retention constants above)
      // from lingering past the token's usefulness.
      archiveCompletedAfterSeconds: ARCHIVE_FINISHED_AFTER_SECONDS,
      archiveFailedAfterSeconds: ARCHIVE_FINISHED_AFTER_SECONDS,
      deleteAfterHours: DELETE_ARCHIVED_AFTER_HOURS,
    });
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

  /** Ensure a queue exists. Idempotent; safe to call from every entrypoint on boot. */
  async createQueue(name: string): Promise<void> {
    await this.boss.createQueue(name);
  }

  /**
   * Enqueue a job on the caller's open transaction. Routing pg-boss's INSERT
   * through `client` (instead of pg-boss's own pool) means the job row and
   * whatever else the caller wrote share one atomic COMMIT: both land or neither
   * does (ADR-0001). Retries are configured here so at-least-once delivery
   * (ADR-0002) holds for every enqueued job.
   */
  async sendInTransaction(name: string, data: object, client: PoolClient): Promise<void> {
    await this.boss.send(name, data, {
      db: { executeSql: (text, values) => client.query(text, values) },
      retryLimit: 5,
      retryBackoff: true,
    });
  }

  /** Register a consumer for a queue. Errors thrown by `handler` trigger pg-boss retries. */
  async work<T extends object>(name: string, handler: JobHandler<T>): Promise<void> {
    await this.boss.work<T>(name, async (jobs) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }
}
