import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './sender.js';

/**
 * SMTP transport behind the {@link EmailSender} seam (issue #8): delivers the
 * Confirmation Email to a real SMTP endpoint. In the demo stack that endpoint is
 * Mailpit, which captures the message so the link is viewable in its inbox — the
 * "realistic email path" for driving the flow by hand. Production would point the
 * same sender at a real relay; no handler changes (ADR-0003 keeps the send site
 * transport-agnostic).
 *
 * The transporter is built once and reused; nodemailer pools connections to the
 * server. `fromAddress` is a display sender only — it doesn't affect delivery to
 * Mailpit, which accepts anything.
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(smtpUrl: string, fromAddress = 'Phoenix <no-reply@phoenix.example>') {
    // Mailpit speaks plain SMTP with no auth or TLS, so the URL alone configures
    // the transport; `createTransport` accepts the connection string directly.
    this.transporter = nodemailer.createTransport(smtpUrl);
    this.fromAddress = fromAddress;
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.body,
    });
  }
}
