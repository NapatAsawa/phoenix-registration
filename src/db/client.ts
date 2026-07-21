import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>;

/** A connection pool shared by the API and worker within a single process. */
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

export function createDb(pool: Pool): ReturnType<typeof drizzle<typeof schema>> {
  return drizzle(pool, { schema });
}
