import { describe, it, expect } from 'vitest';
import { buildConfirmationEmail, buildVerificationUrl } from '../../src/email/confirmation.js';

describe('confirmation email building', () => {
  it('builds a verification URL from PUBLIC_BASE_URL carrying the token', () => {
    const url = buildVerificationUrl('https://phoenix.example', 'tok-123');
    expect(url).toBe('https://phoenix.example/verify?token=tok-123');
  });

  it('preserves a path prefix in the base URL', () => {
    const url = buildVerificationUrl('https://host/app', 'abc');
    expect(url).toBe('https://host/app/verify?token=abc');
  });

  it('url-encodes tokens with special characters', () => {
    const url = buildVerificationUrl('https://host', 'a+b/c=');
    expect(new URL(url).searchParams.get('token')).toBe('a+b/c=');
  });

  it('builds an email addressed to the person with the link in the body', () => {
    const msg = buildConfirmationEmail('alice@example.com', 'https://host/verify?token=xyz');
    expect(msg.to).toBe('alice@example.com');
    expect(msg.subject.length).toBeGreaterThan(0);
    expect(msg.body).toContain('https://host/verify?token=xyz');
  });
});
