import type { PoolClient } from 'pg';
import type { EnqueuerLike } from '../registration/service.js';
import { CONFIRMATION_EMAIL_QUEUE, type ConfirmationEmailJob } from '../queue/jobs.js';
import { buildVerificationUrl } from '../email/confirmation.js';

/**
 * Dev-only affordance (issue #8): remembers the most recently issued confirmation
 * link so a `GET /dev/latest-link` endpoint can hand it back, letting the throwaway
 * UI drive verify-by-hand without opening the mail inbox or scraping a log.
 *
 * It captures the link at the moment the Confirmation Email job is enqueued (see
 * {@link recordConfirmationLinks}) — the one point in the API where the plaintext
 * Verification Token is still in hand. That keeps it transport-agnostic (it works
 * even with the console sender, and needs no Mailpit) and leaves the registration
 * and Resend services untouched, since the capture lives in a decorator around the
 * queue they already depend on.
 */
export interface LatestLink {
  /** The full `…/verify?token=…` link the person would click. */
  link: string;
  /** The Account the link activates, for display alongside it. */
  accountId: string;
}

/** The read side the dev route depends on — just "what was the last link?". */
export interface LatestLinkPort {
  latest(): LatestLink | undefined;
}

/** In-memory store of the single latest link; a fresh Resend overwrites it. */
export class LatestLinkStore implements LatestLinkPort {
  private current: LatestLink | undefined;

  record(link: LatestLink): void {
    this.current = link;
  }

  latest(): LatestLink | undefined {
    return this.current;
  }
}

/**
 * Wraps an {@link EnqueuerLike} so every Confirmation Email enqueued through it
 * also records its link in `store`. Non-confirmation queues pass straight through
 * untouched. The API composes registration/Resend over the wrapped enqueuer, so
 * both the first send and later Resends update the latest link, using the same
 * `publicBaseUrl` the worker will use to build the emailed link.
 */
export function recordConfirmationLinks(
  inner: EnqueuerLike,
  store: LatestLinkStore,
  publicBaseUrl: string,
): EnqueuerLike {
  return {
    async sendInTransaction(name: string, data: object, client: PoolClient): Promise<void> {
      await inner.sendInTransaction(name, data, client);
      if (name === CONFIRMATION_EMAIL_QUEUE) {
        const { accountId, token } = data as ConfirmationEmailJob;
        store.record({ link: buildVerificationUrl(publicBaseUrl, token), accountId });
      }
    },
  };
}
