import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  databaseUrl: string;
  /** Stop the pool and container. */
  teardown: () => Promise<void>;
}

/**
 * Boots an ephemeral Postgres in Docker, runs migrations against it, and returns
 * a ready-to-use pool. This is the integration-test pattern the rest of the work
 * builds on — real Postgres so the consistency guarantees (UNIQUE, concurrent
 * updates) can actually be exercised, torn down when the run finishes.
 */
export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = container.getConnectionUri();
  const pool = new Pool({ connectionString: databaseUrl });

  await runMigrations(pool);

  return {
    container,
    pool,
    databaseUrl,
    teardown: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
