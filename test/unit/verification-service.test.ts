import { describe, it, expect } from 'vitest';
import { verifyToken, type QueryableDb } from '../../src/verification/service.js';
import { hashToken } from '../../src/registration/token.js';

/**
 * These exercise the outcome-mapping logic against a fake that models the
 * conditional-UPDATE semantics: activate only a Pending, non-expired row, then
 * report status for the zero-row cases. The real Postgres row-locking race lives
 * in the integration test; here we pin down verified / already-verified / invalid.
 */
interface FakeAccount {
  tokenHash: string;
  status: 'pending' | 'active';
  expired: boolean;
}

function fakeDb(accounts: FakeAccount[]): QueryableDb {
  return {
    async query(text, values) {
      if (text.trimStart().startsWith('UPDATE')) {
        const [, tokenHash] = values as [string, string, string];
        const acc = accounts.find(
          (a) => a.tokenHash === tokenHash && a.status === 'pending' && !a.expired,
        );
        if (!acc) return { rows: [] };
        acc.status = 'active';
        return { rows: [{ id: 'acc-1' }] };
      }
      // SELECT status ... WHERE token_hash = $1
      const [tokenHash] = values as [string];
      const acc = accounts.find((a) => a.tokenHash === tokenHash);
      return { rows: acc ? [{ status: acc.status }] : [] };
    },
  };
}

const TOKEN = 'plain-token';
const HASH = hashToken(TOKEN);

describe('verifyToken', () => {
  it('activates a Pending account and reports verified', async () => {
    const accounts: FakeAccount[] = [{ tokenHash: HASH, status: 'pending', expired: false }];
    const db = fakeDb(accounts);

    expect(await verifyToken(db, TOKEN)).toEqual({ status: 'verified' });
    expect(accounts[0]!.status).toBe('active');
  });

  it('reports already-verified when the account is already Active', async () => {
    const db = fakeDb([{ tokenHash: HASH, status: 'active', expired: false }]);
    expect(await verifyToken(db, TOKEN)).toEqual({ status: 'already-verified' });
  });

  it('a second verify of the same token is idempotent (verified then already-verified)', async () => {
    const db = fakeDb([{ tokenHash: HASH, status: 'pending', expired: false }]);
    expect(await verifyToken(db, TOKEN)).toEqual({ status: 'verified' });
    expect(await verifyToken(db, TOKEN)).toEqual({ status: 'already-verified' });
  });

  it('reports invalid for an expired (still Pending) token', async () => {
    const db = fakeDb([{ tokenHash: HASH, status: 'pending', expired: true }]);
    expect(await verifyToken(db, TOKEN)).toEqual({ status: 'invalid' });
  });

  it('reports invalid for an unknown token', async () => {
    const db = fakeDb([]);
    expect(await verifyToken(db, TOKEN)).toEqual({ status: 'invalid' });
  });

  it('looks the token up by its sha256, never its plaintext', async () => {
    const seen: unknown[][] = [];
    const db: QueryableDb = {
      async query(_text, values) {
        seen.push(values ?? []);
        return { rows: [] };
      },
    };
    await verifyToken(db, TOKEN);
    for (const values of seen) {
      expect(values).toContain(HASH);
      expect(values).not.toContain(TOKEN);
    }
  });
});
