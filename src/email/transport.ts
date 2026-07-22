import type { EmailTransport } from '../config.js';
import { ConsoleEmailSender, type EmailSender } from './sender.js';
import { SmtpEmailSender } from './smtp-sender.js';

/**
 * Picks the outbound-email transport from config (issue #8) — the one place that
 * maps `EMAIL_TRANSPORT` to a concrete {@link EmailSender}. The worker entrypoint
 * calls this and hands the result to {@link startWorker}; everything downstream
 * depends only on the seam, so swapping console for SMTP is a config change, not a
 * code change.
 */
export function createEmailSender(options: {
  transport: EmailTransport;
  smtpUrl: string;
}): EmailSender {
  switch (options.transport) {
    case 'smtp':
      return new SmtpEmailSender(options.smtpUrl);
    case 'console':
      return new ConsoleEmailSender();
  }
}
