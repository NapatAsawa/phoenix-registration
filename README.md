# phoenix-registration

A highly scalable and reliable registration service that processes registrations, ensures data consistency, supports asynchronous workflows, and sends a Confirmation Email to verify the address before an account becomes Active.

See `CONTEXT.md` for the domain language and `docs/adr/` for design decisions.

## Stack

TypeScript / Node 22, Fastify (API), Drizzle ORM + PostgreSQL, pg-boss (Postgres-backed
job queue). Separate `api` and `worker` entrypoints over a shared domain/db layer, co-run
in dev and deployable as independent replicas (ADR-0003).

## Prerequisites

- Node 22+
- Docker (for `docker compose` and the Testcontainers-based integration tests)

## Setup

```bash
npm install
cp .env.example .env   # adjust if needed
```

## Run

Bring up dependencies (Postgres + Mailpit) and the app in containers:

```bash
docker compose up --build
```

Or run the dependencies in containers and the app on the host:

```bash
docker compose up postgres mailpit -d
npm run db:migrate
npm run dev            # api + worker together
# or individually:
npm run dev:api
npm run dev:worker
```

- Demo UI: http://localhost:3000 — a throwaway page to register, resend, reveal the
  latest confirmation link, and verify by hand against the live API
- Mailpit UI: http://localhost:8025 — the Confirmation Email (with its link) lands here

The compose stack runs the worker with `EMAIL_TRANSPORT=smtp` so emails go to Mailpit, and
runs the api in `development` so the dev-only link endpoint below is reachable. `docker
compose up --build` is the one-command demo: register in the UI, click **Reveal latest
link** (or open the email in Mailpit), then verify.

### Email transport

`EMAIL_TRANSPORT` selects how the worker sends: `console` (default) prints the email to the
worker log; `smtp` delivers to `SMTP_URL` (Mailpit in the demo). It changes only the
transport — nothing else in the flow.

## API

- `POST /registrations` — body `{ email, password }`. Validates at the edge (valid email;
  password 8–128 chars), then in one transaction creates a **Pending** Account (argon2id
  password hash, UNIQUE email) and enqueues the Confirmation Email. Returns `202` on
  success, `400` on invalid input, `409` if the email is already registered. The worker
  sends the Confirmation Email, whose link carries a single-use Verification Token (only its
  sha256 is stored), built from `PUBLIC_BASE_URL`.
- `POST /registrations/{email}/resend` — reissue the Confirmation Email for a still-Pending
  Account, replacing its token. `202` on success, `404` unknown email, `409` already Active,
  `429` throttled (min interval / max count).
- `GET /verify?token=…` — follow the confirmation link. `200` verified (and `200` on a
  repeat — verification is idempotent), `410` for an unknown or expired token.
- `GET /dev/latest-link` — **dev only**: the most recent confirmation link, for driving the
  flow by hand. Not registered when `NODE_ENV=production`, so it is unreachable there.

## Health

- `GET /healthz` — liveness, always 200 while the process is up.
- `GET /readyz` — readiness, 200 when Postgres is reachable and the queue is started,
  503 otherwise.

## Delivery reliability & logging

The Confirmation Email is delivered at-least-once (ADR-0002): the job retries with
exponential backoff up to 5 attempts, then moves to a dead-letter queue and is logged at
error, leaving the Account **Pending** so a resend is still possible. Duplicate delivery is
harmless because verification is idempotent.

Both entrypoints log structured JSON via pino (`LOG_LEVEL`, default `info`). Every line
carries a request id — the Fastify per-request `reqId` on the API, the pg-boss job id on
the worker — and the workflow emits domain-event lines (an `event` field):
`registration.accepted`, `confirmation_email.sent`, `confirmation_email.dead_lettered`,
`account.verified`, `account.expired`.

## Test

```bash
npm test          # unit + integration
```

Integration tests boot an ephemeral Postgres via Testcontainers, run migrations, and prove
the app comes up green. They require a running Docker daemon. On WSL, enable Docker
Desktop's WSL integration for this distro (Settings → Resources → WSL Integration).

## Migrations

Schema lives in `src/db/schema.ts`. After changing it:

```bash
npm run db:generate   # generate a new SQL migration
npm run db:migrate    # apply pending migrations
```
