import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import {
  resendConfirmation,
  RESEND_MAX_COUNT,
  type ResendResult,
} from '../../src/registration/resend.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../../src/queue/jobs.js';
import type { EnqueuerLike, PoolLike } from '../../src/registration/service.js';
import { hashToken } from '../../src/registration/token.js';

/**
 * Resend outcome mapping at the service seam, against a fake that models the
 * Postgres-enforced throttle: the conditional UPDATE fires only for a Pending
 * row that is under the resend cap and past the minimum interval; the zero-row
 * cases are then classified by a follow-up SELECT into not-found / not-pending /
 * throttled. The real row-locking and interval arithmetic live in the
 * integration test; here we pin the branch logic and the transactional enqueue.
 */
interface FakeAccount {
  email: string;
  status: 'pending' | 'active';
  resendCount: number;
  /** How long ago the last Confirmation Email went out; drives the interval guard. */
  intervalElapsed: boolean;
}

interface Enqueued {
  name: string;
  data: ConfirmationEmailJob;
}

function fakeSetup(accounts: FakeAccount[]) {
  const enqueued: Enqueued[] = [];
  const calls: string[] = [];
  let updateValues: unknown[] | undefined;

  const client = {
    async query(text: string, values?: unknown[]) {
      const verb = text.trim().split(/\s+/)[0]!.toUpperCase();
      calls.push(verb);
      if (verb === 'UPDATE') {
        updateValues = values;
        const email = (values as unknown[])[0] as string;
        const acc = accounts.find(
          (a) =>
            a.email === email &&
            a.status === 'pending' &&
            a.resendCount < RESEND_MAX_COUNT &&
            a.intervalElapsed,
        );
        if (!acc) return { rows: [] };
        acc.resendCount += 1;
        acc.intervalElapsed = false; // last_confirmation_sent_at = now()
        return { rows: [{ id: `acc-${email}` }] };
      }
      if (verb === 'SELECT') {
        const email = (values as unknown[])[0] as string;
        const acc = accounts.find((a) => a.email === email);
        return { rows: acc ? [{ status: acc.status }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  };

  const pool: PoolLike = { connect: async () => client as unknown as PoolClient };
  const queue: EnqueuerLike = {
    sendInTransaction: async (name, data, c) => {
      // Must ride the same open transaction: BEGIN + UPDATE before, no COMMIT yet.
      expect(calls).toEqual(['BEGIN', 'UPDATE']);
      expect(c).toBe(client);
      enqueued.push({ name, data: data as ConfirmationEmailJob });
    },
  };

  return { pool, queue, enqueued, calls, updateValues: () => updateValues };
}

describe('resendConfirmation', () => {
  it('regenerates the token and enqueues a fresh Confirmation Email for an eligible Pending account', async () => {
    const s = fakeSetup([
      { email: 'p@x.co', status: 'pending', resendCount: 0, intervalElapsed: true },
    ]);

    const result = await resendConfirmation({ pool: s.pool, queue: s.queue }, 'p@x.co');

    expect(result).toEqual({ ok: true } satisfies ResendResult);
    expect(s.calls).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);

    // A new plaintext token was enqueued...
    expect(s.enqueued).toHaveLength(1);
    expect(s.enqueued[0]!.name).toBe(CONFIRMATION_EMAIL_QUEUE);
    const job = s.enqueued[0]!.data;
    expect(job.token).toBeTruthy();

    // ...and only its sha256 is written to the row (invalidating the prior token).
    // UPDATE params: [email, tokenHash, tokenExpiresAt, status, maxCount, intervalSecs]
    const [, storedTokenHash, tokenExpiresAt] = s.updateValues()!;
    expect(storedTokenHash).toBe(hashToken(job.token));
    expect(storedTokenHash).not.toBe(job.token);
    expect(tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('reports not-found for an unknown email (no enqueue, rolled back)', async () => {
    const s = fakeSetup([]);
    const result = await resendConfirmation({ pool: s.pool, queue: s.queue }, 'nobody@x.co');
    expect(result).toEqual({ ok: false, reason: 'not-found' } satisfies ResendResult);
    expect(s.calls).toEqual(['BEGIN', 'UPDATE', 'ROLLBACK', 'SELECT']);
    expect(s.enqueued).toHaveLength(0);
  });

  it('reports not-pending when the account is already Active', async () => {
    const s = fakeSetup([
      { email: 'a@x.co', status: 'active', resendCount: 0, intervalElapsed: true },
    ]);
    const result = await resendConfirmation({ pool: s.pool, queue: s.queue }, 'a@x.co');
    expect(result).toEqual({ ok: false, reason: 'not-pending' } satisfies ResendResult);
    expect(s.enqueued).toHaveLength(0);
  });

  it('reports throttled when a Pending account is still within the minimum interval', async () => {
    const s = fakeSetup([
      { email: 'p@x.co', status: 'pending', resendCount: 0, intervalElapsed: false },
    ]);
    const result = await resendConfirmation({ pool: s.pool, queue: s.queue }, 'p@x.co');
    expect(result).toEqual({ ok: false, reason: 'throttled' } satisfies ResendResult);
    expect(s.enqueued).toHaveLength(0);
  });

  it('reports throttled when a Pending account has hit the resend cap', async () => {
    const s = fakeSetup([
      { email: 'p@x.co', status: 'pending', resendCount: RESEND_MAX_COUNT, intervalElapsed: true },
    ]);
    const result = await resendConfirmation({ pool: s.pool, queue: s.queue }, 'p@x.co');
    expect(result).toEqual({ ok: false, reason: 'throttled' } satisfies ResendResult);
    expect(s.enqueued).toHaveLength(0);
  });
});
