# ADR 0004 — Token events to BigQuery through Pub/Sub

- **Status:** Accepted
- **Date:** 2026-10-30
- **Phase:** UPGRADE-PLAN 3.2

## Context

Owners want trends over months ("which weekday hour is worst?"). Postgres can
answer that for one clinic, but the reports should not compete with "call
next" on the same database, and a warehouse is the normal home for history.
The owner also has no GCP budget, so everything must run locally first.

## Decision

1. After a token change **commits**, the API builds a flat, PII-free event
   (`src/analytics/token-event.ts`) and publishes it through a port
   (`TokenEventPublisher`). Adapters: Pub/Sub, in-memory (tests), no-op.
   `ANALYTICS_EXPORT=none|pubsub` is the feature flag; default `none`.
2. On GCP, a **Pub/Sub BigQuery subscription** writes each message into the
   `token_events` table (`use_table_schema = true`), with a dead-letter topic.
   No loader service to run or pay for.
3. Locally, the official **Pub/Sub emulator** carries the messages and the
   **goccy BigQuery emulator** stores them. The Pub/Sub emulator has no
   BigQuery subscriptions, so a small loader (`tools/analytics/loader.ts`)
   pulls, validates against the same table schema, inserts, then acks.
4. One SQL view, `avg_wait_by_weekday_hour`, de-duplicates on `event_id` and
   averages first-call waits per tenant, weekday and hour in Colombo time.
   The same `.sql` file is deployed by Terraform and by the local setup tool,
   and is tested against the emulator.

## Trade-offs

- **Publish after commit, not a transactional outbox.** A crash between commit
  and publish loses one analytics row. That is acceptable for trend charts and
  keeps "call next" fast; the publish is not awaited and errors are swallowed.
  If exports ever drive billing or SLAs, add an `outbox` table written in the
  same transaction and drained by a worker.
- **At-least-once delivery.** Pub/Sub may deliver twice. `event_id` is
  deterministic (token id + type + the token's own timestamp), so an
  idempotent replay or a redelivery produces the same id and the view counts
  it once.
- **The schema is a contract.** BigQuery subscriptions map JSON fields to
  columns by name; a renamed field would silently become NULL. A unit test
  fails if the event's keys and `token_events.schema.json` differ.
- **No PII in the warehouse.** No names or phone digits, only ids, states and
  times. This keeps the warehouse out of scope for patient-data requests.
- **Emulator fidelity.** goccy's emulator is SQLite with a GoogleSQL parser;
  it ran this view correctly, but it is not BigQuery. Partitioning, costs and
  quotas can only be checked on real GCP (see docs/CLOUD-LAB.md).
