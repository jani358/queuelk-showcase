# Load test report: the morning rush

UPGRADE-PLAN 5.1. Script: [`load/morning-rush.js`](../samples/load/morning-rush.js) (k6).

## The scenario

A clinic opens. **300 patients take a number by scanning the QR code within
60 seconds** (5 per second, each on a new "phone" with its own device cookie),
while **5 counters** keep pressing "call next", wait 0.3–0.7 s, and press
"Done", for 75 seconds. All of them work the same, freshly created queue.

The teardown reads the queue back and checks the product's promise:

- numbers are exactly **1..N** (no gaps),
- **no duplicate** numbers,
- **nobody was called twice** (no recalls, and no 409 on a "Done", which would
  mean two counters got the same patient).

Thresholds: every patient gets a token, invariants hold, all checks pass, and
**p95 under 250 ms** for patients and counters.

## Setup

- Windows 11, 8 logical CPUs, Node 24. API built (`npm run build`) and run
  with `NODE_ENV=production node dist/main.js` on port 3171.
- Postgres 16 and Redis 7 in Docker (`npm run up`), a separate `queuelk_load`
  database, seeded.
- k6 v2.3.0 on the same machine.
- **The machine was shared**: several other projects' builds, tests and a
  Kubernetes cluster ran at the same time, and CPU load sat around 75% before
  the test started. Absolute latencies are therefore pessimistic and noisy;
  compare runs made close together, and read the correctness columns as solid.

```bash
npm run up
# API on :3171 against a seeded queuelk_load database (see docs/CLOUD-LAB.md)
k6 run -e API=http://localhost:3171/api load/morning-rush.js
```

## Results before the fix (2026-10-30)

| Run | Code | Take number: median / p95 / p99 | Call next: median / p95 | Tokens | Failed requests | Gaps / dups / double calls |
|---|---|---|---|---|---|---|
| 1 | baseline | 80 / **377** / 771 ms | 50 / 176 ms | 301 | 0% | 0 / 0 / 0 |
| 2 | broadcast not awaited | 3,501 / **7,641** / 8,036 ms | 388 / 7,693 ms | 298 of 300 | 0.55% | 0 / 0 / 0 |
| 3 | + coalesced broadcasts | 378 / 2,345 / 2,948 ms | 155 / 1,022 ms | 301 | 0% | 0 / 0 / 0 |
| A/B 1 | baseline | 483 / 1,355 / 1,750 ms | 237 / 966 ms | 300 | 0% | 0 / 0 / 0 |
| A/B 1 | coalesced | 326 / 1,816 / 2,221 ms | 196 / 1,403 ms | 301 | 0% | 0 / 0 / 0 |
| A/B 2 | baseline | 203 / 1,423 / 1,706 ms | 81 / 600 ms | 300 | 0% | 0 / 0 / 0 |
| A/B 2 | coalesced | 202 / **678** / 865 ms | 101 / 497 ms | 301 | 0% | 0 / 0 / 0 |

(301 tokens: k6's constant-arrival-rate executor starts one extra iteration on
the boundary; the check is "at least 300".)

## What this shows

1. **Correctness held in every run, including the broken one.** Across 7 runs
   and about 2,100 tokens: no gaps, no duplicates, no patient called twice.
   This is the row lock on `queue_counters` (then a `SELECT ... FOR UPDATE`,
   now an upsert, see below) plus the unique constraint doing their job, now
   proven under concurrent load and not only in the integration tests.
2. **The 250 ms p95 target was not met on this machine that day.** The quiet-ish
   baseline (run 1) was 377 ms; under heavier background load, 1.3–1.4 s.
3. **Run 2 found a real failure mode.** Making the patient's request stop
   waiting for the display broadcast removed hidden back-pressure; snapshot
   reads piled up, exhausted the Prisma pool, and locked transactions hit the
   5 s timeout. Write-up:
   [postmortem](postmortems/2026-10-30-morning-rush-pool-exhaustion.md).
4. **Coalescing fixed the failure** (no errors since) and bounds broadcast work
   to at most 2 snapshot reads per burst per queue. Whether it is also *faster*
   is not proven: in interleaved A/B runs it won one round clearly (p95 678 vs
   1,423 ms) and lost the other (1,816 vs 1,355 ms). On a machine this noisy,
   that is inside the noise.

## Where the time went

Every write to a queue (issue, call next, done) took the **same queue row
lock** (`SELECT ... FOR UPDATE` on `queues`) and held it for about ten round
trips. So patients queued behind counters, and counters behind patients.

## The fix (2026-10-31, [ADR 0007](adr/0007-issue-on-the-counter-row-only.md))

- Issuing takes **only** the `queue_counters` row lock, first, in one
  `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (also covers the first token
  of the day, so the catch-and-retry branch is gone). The device and capacity
  checks still run under it, and a rejected token still rolls its number back.
- Counter actions lock the queue row with **`FOR NO KEY UPDATE`**. The new
  integration test found that with `FOR UPDATE`, issuing still waited: the token
  INSERT checks its foreign key to `queues` with `FOR KEY SHARE`, which
  `FOR UPDATE` blocks. One test run hung with seven issuers stuck behind it.
- The concurrency suites (25 tests, 4 new) stayed green; the integration suite
  is 113 tests.

## Results after the fix

Same script, same machine, the base build (`6e3924e`) and the new build run
**interleaved**, base then new, in one session. Docker had just been limited to
6 CPUs and only one other project was running, so the machine was much quieter
than on 2026-10-30. "CPU" is Windows' load just before each run.

| Round | Code | CPU | Take number: median / p95 / p99 | Call next: median / p95 | Tokens | Failed | Gaps / dups / double calls |
|---|---|---|---|---|---|---|---|
| 1 | base | 57% | 64 / **124** / 237 ms | 50 / 130 ms | 300 | 0% | 0 / 0 / 0 |
| 1 | new | 26% | 53 / **76** / 91 ms | 40 / 82 ms | 301 | 0% | 0 / 0 / 0 |
| 2 | base | 40% | *invalid: the random queue prefix already existed, so no queue was created (script fixed)* | | | | |
| 2 | new | 68% | 52 / **71** / 88 ms | 43 / 87 ms | 301 | 0% | 0 / 0 / 0 |
| 3 | base | 25% | 68 / **132** / 202 ms | 54 / 127 ms | 300 | 0% | 0 / 0 / 0 |
| 3 | new | 42% | 58 / **84** / 117 ms | 48 / 99 ms | 301 | 0% | 0 / 0 / 0 |
| 4 | base | 31% | 59 / **91** / 150 ms | 46 / 93 ms | 301 | 0% | 0 / 0 / 0 |
| 4 | new | 57% | 57 / **91** / 112 ms | 46 / 111 ms | 301 | 0% | 0 / 0 / 0 |

Earlier the same morning, with the machine at **100% CPU** (Docker's VM and
antivirus), one new run gave take-number p95 4.8 s and one base run 11.5 s.
Those runs were not interleaved closely, so they are not used as a comparison.

## What the new numbers show

1. **The p95 < 250 ms target is met**, by every valid run of both builds, with
   every threshold green. The 377 ms of 2026-10-30 was mostly the machine, not
   the code: the base build also passes once the machine is quiet.
2. **The lock change helps, but less than the machine does.** Take-number p95
   was 76 / 71 / 84 / 91 ms after against 124 / 132 / 91 ms before: lower in
   two of three paired rounds, equal in the fourth. p99 is lower in all three
   paired rounds (91 / 117 / 112 against 237 / 202 / 150 ms), which fits a lock
   change: it cuts the tail, where a patient waited behind a counter. Call-next
   p95 is similar (82–111 against 93–130 ms).
3. **Correctness held in all 11 runs on 2026-10-31** (about 3,300 tokens): no
   gaps, no duplicates, nobody called twice.
4. Honest limits: 3 paired rounds on one laptop, with k6 and the API sharing the
   CPU. A Cloud Run run, where they do not share a CPU, is the next check.

## Reproducing

```bash
npm run up
docker exec queuelk-postgres psql -U queuelk -c "CREATE DATABASE queuelk_load"
cd apps/api
export DATABASE_URL=postgresql://queuelk:<password>@localhost:5432/queuelk_load PORT=3171 \
  JWT_SECRET=<32+ chars> JWT_REFRESH_SECRET=<different 32+ chars> DEVICE_COOKIE_SECRET=<32+ chars> \
  REDIS_URL=redis://localhost:6379
npx prisma migrate deploy && npx ts-node prisma/seed.ts && npm run build
NODE_ENV=production node dist/main.js &
cd ../.. && k6 run load/morning-rush.js
```

Each run creates a new queue (`K??`), so runs do not interfere.
