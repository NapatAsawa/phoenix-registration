import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { createEmailSender } from '../../src/email/transport.js';
import { buildConfirmationEmail, buildVerificationUrl } from '../../src/email/confirmation.js';

/**
 * The SMTP transport (issue #8) against a real Mailpit, exactly the mail server the
 * demo stack runs. Proves that `EMAIL_TRANSPORT=smtp` delivers a Confirmation Email
 * whose link lands in the Mailpit inbox — the realistic email path for driving the
 * flow by hand. Mailpit's HTTP API stands in for a human reading the inbox.
 */
const BASE_URL = 'https://phoenix.example';

interface MailpitMessage {
  ID: string;
}

describe('EMAIL_TRANSPORT=smtp delivers to Mailpit', () => {
  let mailpit: StartedTestContainer;
  let apiBase: string;
  let smtpUrl: string;

  beforeAll(async () => {
    mailpit = await new GenericContainer('axllent/mailpit:latest')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    smtpUrl = `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`;
    apiBase = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  }, 120_000);

  afterAll(async () => {
    await mailpit?.stop();
  });

  it('routes a Confirmation Email to the Mailpit inbox with its verification link', async () => {
    const sender = createEmailSender({ transport: 'smtp', smtpUrl });
    const verificationUrl = buildVerificationUrl(BASE_URL, 'tok-smtp-123');
    await sender.send(buildConfirmationEmail('smtp@example.com', verificationUrl));

    // Poll the inbox until the message shows up (delivery is near-instant, but the
    // API list is eventually consistent with the SMTP accept).
    const message = await waitFor(async () => {
      const res = await fetch(`${apiBase}/api/v1/messages`);
      const body = (await res.json()) as { messages: MailpitMessage[] };
      return body.messages[0];
    });

    const full = await fetch(`${apiBase}/api/v1/message/${message.ID}`);
    const detail = (await full.json()) as { Text: string; To: Array<{ Address: string }> };
    expect(detail.To[0]!.Address).toBe('smtp@example.com');
    expect(detail.Text).toContain(verificationUrl);
  });
});

async function waitFor<T>(get: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for Mailpit message');
    await new Promise((r) => setTimeout(r, 150));
  }
}
