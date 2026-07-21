import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

/** Absolute path to the generated SQL migrations folder. */
export const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
);

/** Apply all pending Drizzle migrations against the given pool. Idempotent. */
export async function runMigrations(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
}
