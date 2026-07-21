# Split-ready process topology: separate api and worker entrypoints, one codebase

The HTTP API (Fastify) and the pg-boss email worker are written as **two separate
entrypoints** over a shared domain/db layer, but run **together in a single process**
for local development and simple deploys. Production can run them as independent
replicas (e.g. N api pods + M worker pods) by launching the two entrypoints separately —
a deploy/config change, not a rewrite.

## Why

The service targets high scalability, which means the API and email-sending must be able
to scale and fail independently: a burst of slow email sends should not steal cycles
from HTTP handling. A fully combined process (simplest) can't do that; a fully split
setup from day one adds orchestration cost during development for a project whose focus
is the backend workflow. Keeping the entrypoints separable but co-running gives the
scaling headroom without the day-one operational tax.

## Consequences

- Domain and DB access live in a shared module imported by both entrypoints; neither
  entrypoint owns state the other needs.
- Local dev runs both via one command; production runs them as separate processes.
- The worker must not depend on the HTTP server being up, and vice versa.
