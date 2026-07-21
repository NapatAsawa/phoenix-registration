import { loadConfig } from '../config.js';
import { createPool } from './client.js';
import { runMigrations } from './migrate.js';

/** Standalone migration runner: `npm run db:migrate`. */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await runMigrations(pool);
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
