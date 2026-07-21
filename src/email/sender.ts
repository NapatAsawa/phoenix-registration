/**
 * The outbound-email seam. Everything that sends mail depends on this interface,
 * never on a concrete transport, so the worker can run against the console in dev
 * and a captured fake in tests while production swaps in SMTP later — no handler
 * changes. (ADR-0003 keeps such shared pieces transport-agnostic.)
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body; contains the confirmation link for the Confirmation Email. */
  body: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Dev/default transport: writes the message to stdout instead of delivering it.
 * Lets the whole registration flow run locally with no mail server, and makes the
 * confirmation link copy-pasteable from the worker log.
 */
export class ConsoleEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    console.log(
      `email → ${message.to}\n  subject: ${message.subject}\n  ${message.body.replace(/\n/g, '\n  ')}`,
    );
  }
}
