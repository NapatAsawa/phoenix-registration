import { describe, it, expect } from 'vitest';
import { parseRegistration } from '../../src/registration/validation.js';

/**
 * The 202-vs-400 decision lives entirely in this pure function, so it is proven
 * here without HTTP: valid input normalizes, everything malformed is rejected.
 */
describe('parseRegistration', () => {
  it('accepts a valid email + in-range password and normalizes the email', () => {
    const result = parseRegistration({ email: '  Alice@Example.COM ', password: 'hunter2!!' });
    expect(result).toEqual({ ok: true, value: { email: 'alice@example.com', password: 'hunter2!!' } });
  });

  it.each([
    ['no @', 'alice.example.com'],
    ['no domain dot', 'alice@example'],
    ['spaces inside', 'ali ce@example.com'],
    ['empty', ''],
  ])('rejects malformed email (%s)', (_label, email) => {
    const result = parseRegistration({ email, password: 'longenough' });
    expect(result.ok).toBe(false);
  });

  it('rejects a password shorter than 8', () => {
    const result = parseRegistration({ email: 'a@b.co', password: '1234567' });
    expect(result.ok).toBe(false);
  });

  it('accepts a password of exactly 8 and exactly 128', () => {
    expect(parseRegistration({ email: 'a@b.co', password: '8'.repeat(8) }).ok).toBe(true);
    expect(parseRegistration({ email: 'a@b.co', password: 'x'.repeat(128) }).ok).toBe(true);
  });

  it('rejects a password longer than 128', () => {
    const result = parseRegistration({ email: 'a@b.co', password: 'x'.repeat(129) });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-object body', () => {
    expect(parseRegistration(null).ok).toBe(false);
    expect(parseRegistration('nope').ok).toBe(false);
  });
});
