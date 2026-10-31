# ADR 0007 — Issue tokens on the counter row only, and lock the queue with FOR NO KEY UPDATE

- **Status:** Accepted
- **Date:** 2026-10-31
- **Phase:** UPGRADE-PLAN 5.1 (follow-up from the morning-rush load test)

## Context

The k6 morning rush ([report](../LOAD-TEST-REPORT.md)) missed its p95 < 250 ms
target. Every write to a queue took the same lock: `SELECT … FOR UPDATE` on the
`queues` row. Issuing a token took it, then the `queue_counters` row lock.
"Call next", "done" and the other counter actions took it too. So patients
queued behind counters, and counters behind patients, for about ten round trips
each.

The numbering promise must not change: numbers 1..N per queue and day, no gaps,
no duplicates, nobody called twice, and a rejected token (capacity full, a
second token from one device) must not burn a number.

## Options

| | Keep one queue lock | Postgres sequence per queue/day | Counter-row lock only for issuing (chosen) |
|---|---|---|---|
| Gap-free | yes | **no**: `nextval()` is not rolled back, so a rejected issue leaves a gap | yes: the increment rolls back with the transaction |
| Issuers vs counters | wait for each other | independent | independent |
| Device and capacity checks | serialised by the queue lock | need another lock | serialised by the counter-row lock, taken first |
| Daily reset | the new day's row | one sequence per queue per day to create and drop | the new day's row (unchanged) |

## Decision

1. **Issuing takes only the `queue_counters` row lock, and takes it first.**
   One statement claims the number:
   `INSERT … ON CONFLICT ("queueId", service_date) DO UPDATE SET last_number = last_number + 1 … RETURNING last_number`.
   It also covers the first token of the day (the unique index makes the second
   inserter wait and then update), which removes the old catch-`P2002`-and-retry
   branch. The device and capacity checks run after it, so they still run one
   issuer at a time. The queue is read without a lock, tenant-scoped.
2. **Counter actions lock the queue row with `FOR NO KEY UPDATE`, not
   `FOR UPDATE`** (`src/tokens/queue-lock.ts`).

The second point was found by the new integration test, not planned. After
step 1, issuing *still* waited for "call next": inserting a token (and a
counter row) checks its foreign key to `queues` with `FOR KEY SHARE`, and
`FOR UPDATE` conflicts with `FOR KEY SHARE`. Worse, the issuer holding the
counter row was then stuck behind the counter, and every other issuer behind
it, holding pool connections: a test run hung with seven issuers waiting.
`FOR NO KEY UPDATE` conflicts with itself, so counter actions stay serialised,
but not with `FOR KEY SHARE`. No counter action changes the queue's key.

## Consequences

- A patient taking a number never waits for a counter, and a counter never
  waits for a patient. Issuers still queue among themselves on one row, for a
  shorter time (one statement fewer inside the lock).
- A pause or close that commits while an issue is in flight can let one last
  token through. That is the same as the patient scanning a few milliseconds
  earlier, and is accepted.
- The concurrency suite has four new tests: issuing completes while a counter
  holds its queue lock; issuers still wait on the counter row; 25 issues and 15
  calls at once keep 1..30 with nobody called twice; another tenant's queue id
  is refused without touching the counter.
- Under heavy machine load the 30-at-once test can hit Prisma's 2 s `maxWait` to
  start a transaction (pool of 9). That is a test-environment limit, seen once
  at 100% CPU, and it passed on re-run. It was the same before this change.
- Measured effect: see the "after" rows in the [load test report](../LOAD-TEST-REPORT.md).
