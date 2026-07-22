import type { FastifyInstance } from 'fastify';
import type { LatestLinkPort } from '../dev/latest-link.js';

/**
 * The dev-only latest-link HTTP surface (issue #8): `GET /dev/latest-link` hands
 * back the most recently issued confirmation link so the throwaway UI can verify
 * by hand. Registered only in non-production — the API entrypoint withholds the
 * port when `NODE_ENV=production`, so the route simply does not exist there, which
 * is a stronger guard than a runtime check (there is nothing to reach).
 *
 * Kept separate from `buildApp` like the other route modules so its 200/404
 * behavior can be driven with a fake port.
 */
export function registerLatestLinkRoutes(app: FastifyInstance, port: LatestLinkPort): void {
  app.get('/dev/latest-link', async (_request, reply) => {
    const latest = port.latest();
    if (!latest) {
      // Nothing registered yet this run — no Confirmation Email has been enqueued.
      return reply.code(404).send({ error: 'no_link_yet' });
    }
    return reply.send(latest);
  });
}
