import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { registerAccount, type EnqueuerLike, type PoolLike } from '../../src/registration/service.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../../src/queue/jobs.js';
import { hashToken } from '../../src/registration/token.js';

/**
 * The atomicity guarantee — account insert and email enqueue commit together or
 * not at all — proven at the service seam with fakes, no real Postgres needed.
 * A real-Postgres end-to-end pass lives in the integration test.
 */

class FakeClient {
  readonly calls: string[] = [];
  released = false;
  insertError: Error | null = null;
  insertValues: unknown[] | undefined;

  async query(text: string, values?: unknown[]): Promise<{ rows: Array<{ id: string }> }> {
    const verb = text.trim().split(/\s+/)[0]!.toUpperCase();
    this.calls.push(verb === 'INSERT' ? 'INSERT' : text.trim());
    if (verb === 'INSERT') {
      if (this.insertError) throw this.insertError;
      this.insertValues = values;
      return { rows: [{ id: 'acc-1' }] };
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

function fakePool(client: FakeClient): PoolLike {
  return { connect: async () => client as unknown as PoolClient };
}

describe('registerAccount transaction', () => {
  const input = { email: 'a@b.co', password: 'longenough' };

  it('commits the account insert and the enqueue together, then releases', async () => {
    const client = new FakeClient();
    const enqueued: Array<{ name: string; data: ConfirmationEmailJob }> = [];
    const queue: EnqueuerLike = {
      sendInTransaction: async (name, data) => {
        // Enqueue must happen inside the tx: BEGIN + INSERT before, no COMMIT yet.
        expect(client.calls).toEqual(['BEGIN', 'INSERT']);
        enqueued.push({ name, data: data as ConfirmationEmailJob });
      },
    };

    const result = await registerAccount({ pool: fakePool(client), queue }, input);

    expect(result).toEqual({ ok: true, accountId: 'acc-1' });
    expect(client.calls).toEqual(['BEGIN', 'INSERT', 'COMMIT']);
    expect(client.released).toBe(true);

    // The job carries the account id and the plaintext token...
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.name).toBe(CONFIRMATION_EMAIL_QUEUE);
    const job = enqueued[0]!.data;
    expect(job.accountId).toBe('acc-1');
    expect(job.token).toBeTruthy();

    // ...and what the row stores is that token's sha256, never the plaintext.
    // INSERT params: [email, passwordHash, status, tokenHash, tokenExpiresAt]
    const [, , , storedTokenHash, tokenExpiresAt] = client.insertValues!;
    expect(storedTokenHash).toBe(hashToken(job.token));
    expect(storedTokenHash).not.toBe(job.token);
    expect(tokenExpiresAt).toBeInstanceOf(Date);
  });

  it('rolls back (no commit) when the enqueue fails, and rethrows', async () => {
    const client = new FakeClient();
    const queue: EnqueuerLike = {
      sendInTransaction: async () => {
        throw new Error('queue down');
      },
    };

    await expect(registerAccount({ pool: fakePool(client), queue }, input)).rejects.toThrow('queue down');
    expect(client.calls).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
    expect(client.calls).not.toContain('COMMIT');
    expect(client.released).toBe(true);
  });

  it('reports duplicate-email (and rolls back) on a UNIQUE violation', async () => {
    const client = new FakeClient();
    client.insertError = Object.assign(new Error('dup'), { code: '23505' });
    const queue: EnqueuerLike = { sendInTransaction: async () => {} };

    const result = await registerAccount({ pool: fakePool(client), queue }, input);

    expect(result).toEqual({ ok: false, reason: 'duplicate-email' });
    expect(client.calls).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
    expect(client.released).toBe(true);
  });
});
