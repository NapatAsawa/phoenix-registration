import Fastify, { type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import { registerRegistrationRoutes, type RegistrationPort } from './api/registrations.js';
import { registerResendRoutes, type ResendPort } from './api/resend.js';
import { registerVerificationRoutes, type VerificationPort } from './api/verify.js';
import { registerUiRoutes } from './api/ui.js';
import { registerLatestLinkRoutes } from './api/dev.js';
import type { LatestLinkPort } from './dev/latest-link.js';

/**
 * Readiness dependencies the app probes on `GET /readyz`. Passing these as
 * functions keeps `buildApp` decoupled from concrete Postgres / pg-boss objects,
 * so the health surface can be tested with fakes and driven with real
 * infrastructure in integration tests.
 */
export interface ReadinessChecks {
  /** Resolves when the database is reachable; rejects otherwise. */
  pingDb: () => Promise<void>;
  /** True when the job queue has started. */
  isQueueStarted: () => boolean;
}

export interface BuildAppOptions {
  checks: ReadinessChecks;
  /**
   * How to log. `false`/omitted is the unit-test default (silent); `true` uses
   * Fastify's own default logger; a pino instance logs through it — which is how
   * the API entrypoint passes the shared process logger (issue #7) so HTTP lines
   * and domain events share one format and carry the per-request `reqId` Fastify
   * binds onto `request.log`.
   */
  logger?: boolean | FastifyBaseLogger;
  /**
   * Registration write side. Optional so the health surface can be built in
   * isolation (as the unit tests do); the API entrypoint always supplies it.
   */
  registration?: RegistrationPort;
  /**
   * Resend write side (`POST /registrations/{email}/resend`). Optional for the
   * same reason as `registration`; the API entrypoint always supplies it.
   */
  resend?: ResendPort;
  /**
   * Verification write side (`GET /verify`). Optional for the same reason as
   * `registration`; the API entrypoint always supplies it.
   */
  verification?: VerificationPort;
  /**
   * When true, serves the throwaway demo UI at `/` (issue #8). Off in unit tests
   * that only exercise the JSON surface.
   */
  ui?: boolean;
  /**
   * Dev-only latest-link read side (`GET /dev/latest-link`). Supplied by the API
   * entrypoint only outside production; when omitted the route is not registered,
   * so it is unreachable in production by construction.
   */
  latestLink?: LatestLinkPort;
}

/**
 * Builds the Fastify app exposing the operational health surface, plus the
 * registration route when a {@link RegistrationPort} is supplied.
 *
 * - `GET /healthz` (liveness): always 200 while the process is up.
 * - `GET /readyz` (readiness): 200 when the DB is reachable and the queue is
 *   started; 503 otherwise.
 * - `POST /registrations`: creates a Pending Account and queues its Confirmation
 *   Email (only when `registration` is provided).
 * - `POST /registrations/{email}/resend`: reissues the Confirmation Email for a
 *   still-Pending Account, throttled (only when `resend` is provided).
 * - `GET /verify`: flips a Pending Account to Active by its Verification Token
 *   (only when `verification` is provided).
 * - `GET /`: the throwaway demo UI (only when `ui` is set).
 * - `GET /dev/latest-link`: the dev-only latest confirmation link (only when
 *   `latestLink` is provided — the entrypoint withholds it in production).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  // A pino instance goes in as loggerInstance; a boolean toggles Fastify's own.
  const app =
    typeof options.logger === 'object'
      ? Fastify({ loggerInstance: options.logger })
      : Fastify({ logger: options.logger ?? false });
  const { checks } = options;

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const details: { db: boolean; queue: boolean } = { db: false, queue: false };

    try {
      await checks.pingDb();
      details.db = true;
    } catch {
      details.db = false;
    }

    details.queue = checks.isQueueStarted();

    if (details.db && details.queue) {
      return { status: 'ready', ...details };
    }
    return reply.code(503).send({ status: 'not-ready', ...details });
  });

  if (options.registration) {
    registerRegistrationRoutes(app, options.registration);
  }

  if (options.resend) {
    registerResendRoutes(app, options.resend);
  }

  if (options.verification) {
    registerVerificationRoutes(app, options.verification);
  }

  if (options.ui) {
    registerUiRoutes(app);
  }

  if (options.latestLink) {
    registerLatestLinkRoutes(app, options.latestLink);
  }

  return app;
}
