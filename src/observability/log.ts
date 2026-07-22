import { pino, type Logger } from 'pino';

/**
 * The logging seam shared by both entrypoints (ADR-0003). One pino factory so the
 * API and the worker emit the same structured JSON, and one place that names the
 * domain events, so a producer and a log-scraping consumer can't drift on the
 * spelling — the same discipline the queue contract (jobs.ts) applies to job names.
 *
 * Every line carries a request id: on the API it's the Fastify per-request `reqId`
 * (Fastify makes `request.log` a child bound to it); on the worker it's the pg-boss
 * job id, bound as `reqId` on a per-job child logger. So any line — HTTP or
 * background — traces back to the unit of work that emitted it (issue #7).
 */

export type { Logger };

/**
 * Canonical domain-event names. Emitted as the `event` field on an otherwise
 * ordinary log line (`log.info({ event, accountId }, msg)`), so operators can
 * filter the workflow by event without parsing messages. Kept as one frozen map
 * so the five names live in exactly one place.
 */
export const DOMAIN_EVENT = {
  /** A registration was accepted (202): a Pending account created, or a Resend queued. */
  registrationAccepted: 'registration.accepted',
  /** The worker delivered a Confirmation Email for a still-Pending account. */
  confirmationEmailSent: 'confirmation_email.sent',
  /** A Confirmation Email job exhausted its retries and was dead-lettered (error). */
  confirmationEmailDeadLettered: 'confirmation_email.dead_lettered',
  /** A Pending account was flipped to Active by following its verification link. */
  accountVerified: 'account.verified',
  /** The Sweep expired a Pending account past the TTL, freeing its email. */
  accountExpired: 'account.expired',
} as const;

export type DomainEvent = (typeof DOMAIN_EVENT)[keyof typeof DOMAIN_EVENT];

/**
 * Build the process logger. JSON to stdout (pino's default) so logs are structured
 * for aggregation; `level` comes from config. The entrypoints create one and pass
 * it down — nothing reaches for a global.
 */
export function createLogger(options: { level?: string } = {}): Logger {
  return pino({ level: options.level ?? 'info' });
}
