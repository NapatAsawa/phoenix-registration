# Postgres-backed job queue (pg-boss) for async work

The confirmation email is sent asynchronously by a worker rather than inline in the
registration request. We use **pg-boss**, a queue that stores jobs in the same
PostgreSQL database as the account write model, instead of a dedicated broker
(Redis/BullMQ, RabbitMQ, Kafka).

## Why

The decisive reason is consistency: the email job is enqueued in the **same database
transaction** that inserts the Pending account. Either both commit or neither does, so
we can never create an account without a pending email job, nor queue an email for an
account that failed to persist. A separate broker would reintroduce the "committed to
the DB but not to the broker" dual-write gap, which the service's consistency goals
explicitly want to avoid. It also means one fewer piece of infrastructure to run.

## Considered and rejected

- **Redis + BullMQ** — the Node-ecosystem default; higher throughput ceiling, but the
  enqueue is a separate system from the account write, reopening the dual-write gap.
  Reconsider if job throughput outgrows what Postgres can serve.
- **RabbitMQ / Kafka** — heavier brokers, overkill for a single job type, same
  dual-write gap.
