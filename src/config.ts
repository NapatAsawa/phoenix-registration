/**
 * Environment-driven configuration.
 *
 * All knobs come from env vars (see `.env.example`). `loadConfig` reads and
 * validates them once at startup; entrypoints pass the result down rather than
 * reaching for `process.env` themselves.
 */

export interface Config {
  nodeEnv: string;
  /** Postgres connection string, shared by the write model and pg-boss. */
  databaseUrl: string;
  /** Port the Fastify API listens on. */
  apiPort: number;
  /** Base URL verification links are built from. */
  publicBaseUrl: string;
}

function required(name: string, value: string | undefined): string {
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function intWithDefault(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be an integer, got: ${value}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    apiPort: intWithDefault('API_PORT', env.API_PORT, 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
  };
}
