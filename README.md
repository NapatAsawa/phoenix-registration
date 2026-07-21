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

- API: http://localhost:3000
- Mailpit UI: http://localhost:8025

## API

- `POST /registrations` — body `{ email, password }`. Validates at the edge (valid email;
  password 8–128 chars), then in one transaction creates a **Pending** Account (argon2id
  password hash, UNIQUE email) and enqueues the Confirmation Email. Returns `202` on
  success, `400` on invalid input, `409` if the email is already registered. The worker
  sends the Confirmation Email, whose link carries a single-use Verification Token (only its
  sha256 is stored), built from `PUBLIC_BASE_URL`.

## Health

- `GET /healthz` — liveness, always 200 while the process is up.
- `GET /readyz` — readiness, 200 when Postgres is reachable and the queue is started,
  503 otherwise.

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
