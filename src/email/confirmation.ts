import type { EmailMessage } from './sender.js';

/**
 * Builds the Confirmation Email (CONTEXT.md): the message whose link the person
 * follows to verify their address. Pure string-building, separated from sending
 * and from token minting, so a test can assert the link and token without a
 * transport or a database.
 */

/**
 * The verification link the person clicks. `publicBaseUrl` comes from config so
 * links point at the externally reachable host, not wherever the worker happens
 * to run. The plaintext token rides in the query string; its hash is what we
 * stored.
 */
export function buildVerificationUrl(publicBaseUrl: string, token: string): string {
  const url = new URL('verify', ensureTrailingSlash(publicBaseUrl));
  url.searchParams.set('token', token);
  return url.toString();
}

export function buildConfirmationEmail(to: string, verificationUrl: string): EmailMessage {
  return {
    to,
    subject: 'Confirm your email address',
    body: [
      'Welcome! Confirm your email address to activate your account:',
      '',
      verificationUrl,
      '',
      'This link expires in 24 hours. If you did not register, ignore this email.',
    ].join('\n'),
  };
}

// Resolving the relative `verify` against the base needs the base to end in `/`,
// otherwise `new URL` drops the last path segment of PUBLIC_BASE_URL (e.g. the
// `/app` in https://host/app).
function ensureTrailingSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}
