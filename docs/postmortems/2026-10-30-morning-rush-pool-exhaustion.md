# Postmortem: unawaited broadcasts exhausted the database pool in the morning-rush test

- **Date:** 2026-10-30
- **Where:** local load test (`load/morning-rush.js`), not production. No
  patient was affected. Written up in full because the same change would have
  shipped otherwise, and because it is the kind of failure that only shows
  under load.
- **Format:** blameless. "We" is the person and the coding agent pairing.
- **Status:** resolved; one follow-up open (pool wait metric, see Actions).

## Summary

To make taking a number faster, we stopped awaiting the queue broadcast after
a token is issued. Under the morning rush (300 patients in 60 s plus 5
counters), p95 for taking a token went from **377 ms to 7.6 s**, 2 patients got
a 500, and one "Done" failed. The broadcasts were no longer awaited, so nothing
limited how many ran at once; each one reads the whole queue snapshot from
Postgres, and together they used every connection in Prisma's pool. The
transactions that hold the queue lock then waited for a connection, went past
Prisma's 5-second interactive transaction timeout, and were rolled back.

Correctness held: numbers were still exactly 1..N with no duplicates, because
the rollback releases the number with the transaction.

## Timeline (2026-10-30, Asia/Colombo)

| Time | What happened |
|---|---|
| 20:38 | Run 1, baseline: all invariants hold; patient p95 377 ms, over the 250 ms target. |
| 20:40 | Change: `void this.queues.broadcast(...)` in `TokensService.issue`, so the patient does not wait for the displays to be told. |
| 20:41 | Run 2: patient p95 7.64 s, counters p95 5.58 s, 2 failed token requests, 1 failed Done. |
| 20:42 | API log: `Transaction already closed ... timeout 5000 ms, however 5088 ms passed`. |
| 20:44 | Diagnosis: unbounded concurrent snapshot reads; awaiting had been acting as back-pressure. |
| 20:45 | Fix: `Coalescer`, at most one broadcast in flight per queue plus one queued (TDD, 5 tests). |
| 20:46 | Run 3: no failures, invariants hold. Latency back in the same range as the baseline on a loaded machine (see the report). |

## Root cause

`QueuesService.broadcast` runs `snapshot()` (several queries) and publishes the
result. Every token change asks for one. When the caller awaited it, a request
could only start a new broadcast after finishing the previous one, so the
number of concurrent snapshot reads was bounded by the number of in-flight
requests. Removing the `await` removed that bound: at 5 issues per second plus
the counters, broadcasts overlapped faster than they finished.

The deeper cause: the API had **implicit back-pressure that nobody had written
down.** The code read as "broadcast after commit", not "and this await is what
keeps the pool healthy".

## What went well

- The load test asserted invariants, not just latency, so we knew at once that
  numbering was still correct.
- Prisma's transaction timeout turned a slow failure into a loud one.
- The design rule "a broadcast failure must never fail the action" (in
  `broadcast`'s catch) held.

## What went wrong

- A latency change was made without a hypothesis about its cost.
- There was no metric for database pool saturation.
- The machine was shared with other heavy jobs, so single runs were noisy and
  slower to read.

## Actions

| Action | Status |
|---|---|
| Coalesce broadcasts per queue (`src/realtime/coalescer.ts`): a burst of N changes costs at most 2 snapshot reads. | Done |
| Comment at the `void` call that it is safe only because of the coalescer. | Done |
| Interleaved A/B runs (base, new, base, new) instead of one-off runs. | Done, in `docs/LOAD-TEST-REPORT.md` |
| Shorten the queue-lock hold time: take the `queue_counters` lock first in `issue` and stop taking the queue row lock there, so patients stop queueing behind counters. Needs the concurrency suite and a quiet machine to prove. | Done 2026-10-31 (ADR 0007; counters also lock with `FOR NO KEY UPDATE`) |
| Log Prisma pool wait time as a metric. | Open |
