import { describe, it, expect } from 'vitest';
import { buildApp } from '../../src/app.js';

/**
 * Health-surface behavior driven with fake readiness checks — no real
 * infrastructure. The Testcontainers integration test proves the same surface
 * against a real Postgres + queue.
 */
describe('health surface', () => {
  it('GET /healthz returns 200 regardless of dependency state', async () => {
    const app = buildApp({
      checks: { pingDb: async () => { throw new Error('down'); }, isQueueStarted: () => false },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /readyz returns 200 when DB reachable and queue started', async () => {
    const app = buildApp({
      checks: { pingDb: async () => {}, isQueueStarted: () => true },
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ready', db: true, queue: true });
    await app.close();
  });

  it('GET /readyz returns 503 when DB unreachable', async () => {
    const app = buildApp({
      checks: { pingDb: async () => { throw new Error('down'); }, isQueueStarted: () => true },
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not-ready', db: false, queue: true });
    await app.close();
  });

  it('GET /readyz returns 503 when queue not started', async () => {
    const app = buildApp({
      checks: { pingDb: async () => {}, isQueueStarted: () => false },
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'not-ready', db: true, queue: false });
    await app.close();
  });
});

const checks = { pingDb: async () => {}, isQueueStarted: () => true };

describe('demo UI', () => {
  it('serves an HTML page at / when ui is enabled', async () => {
    const app = buildApp({ checks, ui: true });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Phoenix Registration');
    await app.close();
  });

  it('does not serve / when ui is off', async () => {
    const app = buildApp({ checks });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('dev latest-link route', () => {
  it('returns the latest link when the port has one', async () => {
    const app = buildApp({
      checks,
      latestLink: { latest: () => ({ link: 'https://phoenix.example/verify?token=t', accountId: 'a' }) },
    });
    const res = await app.inject({ method: 'GET', url: '/dev/latest-link' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ link: 'https://phoenix.example/verify?token=t', accountId: 'a' });
    await app.close();
  });

  it('404s when no link has been recorded yet', async () => {
    const app = buildApp({ checks, latestLink: { latest: () => undefined } });
    const res = await app.inject({ method: 'GET', url: '/dev/latest-link' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'no_link_yet' });
    await app.close();
  });

  it('is unreachable when the port is withheld (as in production)', async () => {
    const app = buildApp({ checks });
    const res = await app.inject({ method: 'GET', url: '/dev/latest-link' });
    expect(res.statusCode).toBe(404);
    // Fastify's own "route not found", not our handler's `no_link_yet` — the route
    // truly does not exist rather than answering with an empty-store response.
    expect(res.json()).not.toMatchObject({ error: 'no_link_yet' });
    await app.close();
  });
});
