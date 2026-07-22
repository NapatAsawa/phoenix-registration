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
  /** When set, a classification SELECT (Resend path) reports this account status. */
  existingStatus: string | null = null;

  async query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
    const verb = text.trim().split(/\s+/)[0]!.toUpperCase();
    this.calls.push(verb === 'INSERT' ? 'INSERT' : verb);
    if (verb === 'INSERT') {
      if (this.insertError) throw this.insertError;
      this.insertValues = values;
      return { rows: [{ id: 'acc-1' }] };
    }
    if (verb === 'SELECT') {
      return { rows: this.existingStatus ? [{ status: this.existingStatus }] : [] };
    }
    // BEGIN / COMMIT / ROLLBACK, and the Resend UPDATE (no eligible row here).
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

    expect(result).toEqual({ ok: true, outcome: 'created', accountId: 'acc-1' });
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

  it('reports duplicate-email on a UNIQUE violation against an already-Active account', async () => {
    // Insert collides; the Resend path then classifies the existing row as Active,
    // so the collision is a genuine 409 (not a Resend). Issue #5.
    const client = new FakeClient();
    client.insertError = Object.assign(new Error('dup'), { code: '23505' });
    client.existingStatus = 'active';
    const queue: EnqueuerLike = { sendInTransaction: async () => {} };

    const result = await registerAccount({ pool: fakePool(client), queue }, input);

    expect(result).toEqual({ ok: false, reason: 'duplicate-email' });
    // Insert rolls back, then the Resend UPDATE matches nothing and a SELECT
    // reveals the Active account.
    expect(client.calls).toEqual(['BEGIN', 'INSERT', 'ROLLBACK', 'BEGIN', 'UPDATE', 'ROLLBACK', 'SELECT']);
    expect(client.released).toBe(true);
  });

  it('handles a UNIQUE violation against a still-Pending account as a Resend', async () => {
    // Insert collides; the existing row is Pending and eligible, so a fresh
    // Confirmation Email is enqueued and the result is a Resend (issue #5).
    const client = new FakeClient();
    client.insertError = Object.assign(new Error('dup'), { code: '23505' });
    // Model an eligible Pending row: the Resend UPDATE returns a row.
    const original = client.query.bind(client);
    client.query = async (text: string, values?: unknown[]) => {
      const verb = text.trim().split(/\s+/)[0]!.toUpperCase();
      if (verb === 'UPDATE') {
        client.calls.push('UPDATE');
        return { rows: [{ id: 'acc-1' }] };
      }
      return original(text, values);
    };
    const enqueued: unknown[] = [];
    const queue: EnqueuerLike = { sendInTransaction: async (name, data) => void enqueued.push({ name, data }) };

    const result = await registerAccount({ pool: fakePool(client), queue }, input);

    expect(result).toEqual({ ok: true, outcome: 'resent' });
    expect(enqueued).toHaveLength(1);
  });
});
