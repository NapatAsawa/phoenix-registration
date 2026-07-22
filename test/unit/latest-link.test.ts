import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { LatestLinkStore, recordConfirmationLinks } from '../../src/dev/latest-link.js';
import { CONFIRMATION_EMAIL_QUEUE, SWEEP_QUEUE } from '../../src/queue/jobs.js';
import type { EnqueuerLike } from '../../src/registration/service.js';

/** Records what it was asked to enqueue; the decorator should always delegate. */
class SpyEnqueuer implements EnqueuerLike {
  readonly sends: Array<{ name: string; data: object }> = [];
  async sendInTransaction(name: string, data: object): Promise<void> {
    this.sends.push({ name, data });
  }
}

const client = {} as PoolClient;
const BASE = 'https://phoenix.example';

describe('recordConfirmationLinks', () => {
  it('captures the link (built from the job token) on a Confirmation Email enqueue', async () => {
    const inner = new SpyEnqueuer();
    const store = new LatestLinkStore();
    const enqueuer = recordConfirmationLinks(inner, store, BASE);

    await enqueuer.sendInTransaction(
      CONFIRMATION_EMAIL_QUEUE,
      { accountId: 'acc-1', token: 'tok-abc' },
      client,
    );

    // Delegated to the real enqueuer …
    expect(inner.sends).toEqual([
      { name: CONFIRMATION_EMAIL_QUEUE, data: { accountId: 'acc-1', token: 'tok-abc' } },
    ]);
    // … and recorded the link the worker will email.
    expect(store.latest()).toEqual({
      link: `${BASE}/verify?token=tok-abc`,
      accountId: 'acc-1',
    });
  });

  it('overwrites the latest link on the next Confirmation Email (a Resend)', async () => {
    const store = new LatestLinkStore();
    const enqueuer = recordConfirmationLinks(new SpyEnqueuer(), store, BASE);

    await enqueuer.sendInTransaction(CONFIRMATION_EMAIL_QUEUE, { accountId: 'a', token: 't1' }, client);
    await enqueuer.sendInTransaction(CONFIRMATION_EMAIL_QUEUE, { accountId: 'a', token: 't2' }, client);

    expect(store.latest()?.link).toBe(`${BASE}/verify?token=t2`);
  });

  it('ignores non-confirmation queues', async () => {
    const store = new LatestLinkStore();
    const enqueuer = recordConfirmationLinks(new SpyEnqueuer(), store, BASE);

    await enqueuer.sendInTransaction(SWEEP_QUEUE, {}, client);

    expect(store.latest()).toBeUndefined();
  });
});
