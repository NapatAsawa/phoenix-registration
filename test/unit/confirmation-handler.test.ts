import { describe, it, expect } from 'vitest';
import { makeConfirmationEmailHandler, type QueryableDb } from '../../src/email/confirmation-handler.js';
import type { EmailMessage, EmailSender } from '../../src/email/sender.js';

class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

/** Fake DB serving one account row (or none, for the not-Pending case). */
function fakeDb(row: { email: string } | null): QueryableDb {
  return {
    async query() {
      return { rows: row ? [row] : [] };
    },
  };
}

function tokenInBody(message: EmailMessage): string {
  const url = new URL(message.body.match(/https?:\/\/\S+/)![0]);
  expect(url.origin + url.pathname).toBe('https://phoenix.example/verify');
  return url.searchParams.get('token')!;
}

describe('confirmation email handler', () => {
  const deps = (row: { email: string } | null, sender: EmailSender) => ({
    db: fakeDb(row),
    emailSender: sender,
    publicBaseUrl: 'https://phoenix.example',
  });

  it('sends a Confirmation Email whose link carries the token from the job', async () => {
    const sender = new CapturingSender();
    const handler = makeConfirmationEmailHandler(deps({ email: 'alice@example.com' }, sender));

    await handler({ accountId: 'acc-1', token: 'tok-abc' });

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe('alice@example.com');
    expect(tokenInBody(sender.sent[0]!)).toBe('tok-abc');
  });

  it('re-sends the identical link on retry (same job → same token, ADR-0002)', async () => {
    const sender = new CapturingSender();
    const handler = makeConfirmationEmailHandler(deps({ email: 'alice@example.com' }, sender));

    await handler({ accountId: 'acc-1', token: 'tok-xyz' });
    await handler({ accountId: 'acc-1', token: 'tok-xyz' });

    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]!.body).toBe(sender.sent[1]!.body);
  });

  it('does nothing for an account that is not Pending', async () => {
    const sender = new CapturingSender();
    const handler = makeConfirmationEmailHandler(deps(null, sender));

    await handler({ accountId: 'gone', token: 'tok' });

    expect(sender.sent).toHaveLength(0);
  });
});
