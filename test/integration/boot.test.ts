import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../../src/app.js';
import { Queue } from '../../src/queue/queue.js';
import { readinessChecks } from '../../src/runtime.js';
import { startTestPostgres, type TestPostgres } from '../helpers/postgres.js';
import type { FastifyInstance } from 'fastify';

/**
 * The first green integration test: against a real, migrated Postgres, the app
 * boots, the queue starts, the DB is reachable, and the health surface reports
 * ready. Proves the walking skeleton comes up green end-to-end.
 */
describe('walking skeleton boots green', () => {
  let pg: TestPostgres;
  let queue: Queue;
  let app: FastifyInstance;

  beforeAll(async () => {
    pg = await startTestPostgres();
    queue = new Queue(pg.databaseUrl);
    await queue.start();
    app = buildApp({ checks: readinessChecks({ pool: pg.pool, queue }) });
  });

  afterAll(async () => {
    await app?.close();
    await queue?.stop();
    await pg?.teardown();
  });

  it('the database is reachable and migrated (accounts table exists)', async () => {
    const res = await pg.pool.query(
      "SELECT to_regclass('public.accounts') AS tbl",
    );
    expect(res.rows[0]?.tbl).toBe('accounts');
  });

  it('GET /healthz returns 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /readyz returns 200 with DB reachable and queue started', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', db: true, queue: true });
  });
});
