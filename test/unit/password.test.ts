import { describe, it, expect } from 'vitest';
import { hashPassword } from '../../src/registration/password.js';

describe('password hashing', () => {
  it('produces an argon2id hash that never equals the plaintext', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse battery');
  });

  it('salts: the same password hashes differently each time', async () => {
    const [a, b] = await Promise.all([hashPassword('samesame'), hashPassword('samesame')]);
    expect(a).not.toEqual(b);
  });
});
