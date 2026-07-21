# At-least-once confirmation email, made safe by idempotent verification

The Confirmation Email job retries with exponential backoff (up to 5 attempts) and
moves to a dead-letter queue on exhaustion. We deliberately accept **at-least-once**
delivery rather than building exactly-once send machinery. Safety comes instead from
making **verification idempotent**.

## Why

A worker can crash after the email is sent but before pg-boss acks the job, so the job
retries and the person receives the same link again (same job → same token). People also
double-click links, browsers prefetch, and mail scanners follow links automatically.
Guaranteeing exactly-once *send* would need a dedup table and careful ordering for
little benefit, because the token is identical across retries and verifying twice is
harmless.

Verification is idempotent via a single atomic conditional update:
`UPDATE ... SET status='active' WHERE token_hash = sha256(token) AND status='pending'
AND token_expires_at > now()`. One row updated → first success (`200 verified`); zero
rows with the account already Active → idempotent hit (`200 already verified`); zero rows
otherwise → `410`. The `status='pending'` predicate also makes concurrent clicks safe:
only one UPDATE can match the Pending row.

## Consequences

- A person may occasionally receive two identical Confirmation Emails. Acceptable.
- The consumed token row is **kept briefly** (not hard-deleted on use) so verify can
  distinguish "already verified" from "never existed"; the hourly sweep cleans it up.
- On dead-letter exhaustion the account stays Pending; the person can trigger a resend.
