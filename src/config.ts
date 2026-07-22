/**
 * Environment-driven configuration.
 *
 * All knobs come from env vars (see `.env.example`). `loadConfig` reads and
 * validates them once at startup; entrypoints pass the result down rather than
 * reaching for `process.env` themselves.
 */

import { PENDING_TTL_MS } from './sweep/service.js';

/** Outbound-email transports the worker can select via `EMAIL_TRANSPORT`. */
export type EmailTransport = 'console' | 'smtp';

export interface Config {
  nodeEnv: string;
  /** Postgres connection string, shared by the write model and pg-boss. */
  databaseUrl: string;
  /** Port the Fastify API listens on. */
  apiPort: number;
  /** Base URL verification links are built from. */
  publicBaseUrl: string;
  /** How long an unconfirmed Registration lives before the Sweep expires it. */
  pendingTtlMs: number;
  /** pino log level (`trace`…`fatal`); both entrypoints log at this level. */
  logLevel: string;
  /**
   * Which outbound-email transport the worker builds (issue #8). `console` (the
   * default) writes the Confirmation Email to stdout so the flow runs with no mail
   * server; `smtp` delivers to a real SMTP endpoint (Mailpit in the demo stack).
   */
  emailTransport: EmailTransport;
  /** SMTP endpoint used when `emailTransport` is `smtp`; Mailpit listens here. */
  smtpUrl: string;
}

/** Duration suffixes accepted in env vars, expressed in milliseconds. */
const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function emailTransport(value: string | undefined): EmailTransport {
  if (value === undefined || value === '' || value === 'console') return 'console';
  if (value === 'smtp') return 'smtp';
  throw new Error(`Env var EMAIL_TRANSPORT must be 'console' or 'smtp', got: ${value}`);
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

/**
 * Parse a duration like `72h`, `24h`, `60s`, `500ms` into milliseconds. This is
 * the form the TTL knobs use in `.env.example`, so config stays readable rather
 * than forcing raw millisecond counts. Falls back when the var is unset.
 */
export function durationWithDefault(
  name: string,
  value: string | undefined,
  fallbackMs: number,
): number {
  if (value === undefined || value === '') return fallbackMs;
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  const unitMs = unit === undefined ? undefined : DURATION_UNITS[unit];
  if (amount === undefined || unitMs === undefined) {
    throw new Error(`Env var ${name} must be a duration like 72h, got: ${value}`);
  }
  return Number(amount) * unitMs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    nodeEnv: env.NODE_ENV ?? 'development',
    databaseUrl: required('DATABASE_URL', env.DATABASE_URL),
    apiPort: intWithDefault('API_PORT', env.API_PORT, 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    pendingTtlMs: durationWithDefault('PENDING_TTL', env.PENDING_TTL, PENDING_TTL_MS),
    logLevel: env.LOG_LEVEL ?? 'info',
    emailTransport: emailTransport(env.EMAIL_TRANSPORT),
    smtpUrl: env.SMTP_URL ?? 'smtp://localhost:1025',
  };
}
