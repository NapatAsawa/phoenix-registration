import { describe, it, expect } from 'vitest';
import { createEmailSender } from '../../src/email/transport.js';
import { ConsoleEmailSender } from '../../src/email/sender.js';
import { SmtpEmailSender } from '../../src/email/smtp-sender.js';

/**
 * The transport factory maps `EMAIL_TRANSPORT` to a concrete sender. Constructing
 * the SMTP sender opens no connection (nodemailer connects lazily on first send),
 * so this stays a pure unit test; the real Mailpit round-trip is covered by the
 * delivery integration test.
 */
describe('createEmailSender', () => {
  it('builds the console sender by default', () => {
    const sender = createEmailSender({ transport: 'console', smtpUrl: 'smtp://localhost:1025' });
    expect(sender).toBeInstanceOf(ConsoleEmailSender);
  });

  it('builds the SMTP sender when transport is smtp', () => {
    const sender = createEmailSender({ transport: 'smtp', smtpUrl: 'smtp://localhost:1025' });
    expect(sender).toBeInstanceOf(SmtpEmailSender);
  });
});
