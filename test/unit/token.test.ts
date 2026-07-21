import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateVerificationToken, hashToken } from '../../src/registration/token.js';

describe('verification token', () => {
  it('hashToken is sha256 hex of the token', () => {
    const expected = createHash('sha256').update('abc').digest('hex');
    expect(hashToken('abc')).toBe(expected);
  });

  it('generateVerificationToken returns a token whose hash matches, and never stores plaintext', () => {
    const { token, tokenHash } = generateVerificationToken();
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).not.toContain(token);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it('mints a distinct token each call', () => {
    expect(generateVerificationToken().token).not.toEqual(generateVerificationToken().token);
  });
});
