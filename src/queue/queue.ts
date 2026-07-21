import PgBoss from 'pg-boss';

/**
 * Thin wrapper over pg-boss that tracks started state so readiness checks can
 * report whether the queue is up. pg-boss stores its jobs in the same Postgres
 * database as the write model (ADR-0001), which is what lets the confirmation
 * email be enqueued in the same transaction that creates the account.
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
}
