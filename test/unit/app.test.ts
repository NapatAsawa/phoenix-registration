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
