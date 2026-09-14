# QueueLK — Multi-tenant Token & Queue Management · Showcase

> **This is a public showcase of a private product.** The full source is private (it is being built as a SaaS).
> This repo contains the architecture, database and security design, selected code excerpts, and a demo,
> so that recruiters and clients can evaluate the concept and the engineering quality.
> Full read-only source access can be granted on request for interviews. See [LICENSE](LICENSE).

**Author:** Janindu Gayanga · [iamjanindu.com](https://iamjanindu.com) · [LinkedIn](https://www.linkedin.com/in/janindu-gayanga-02ba60217) · janindugayanga10@gmail.com

---

## The problem

In a Sri Lankan dispensary, two or three doctors see patients in turn. A patient walks in, takes a
paper number, and then has no idea whether the queue is at 12 or at 40.

So they do one of two things. They sit on a plastic chair for two hours because they daren't leave.
Or they wander off to the shop, come back, and find their number was called fifteen minutes ago and
they've lost their turn. Now there is an argument.

Meanwhile the staff member's actual job for the whole session is shouting numbers across a crowded
room with a fan running.

**QueueLK replaces the shouting with a screen on the wall and a page on the patient's phone.** They
scan a QR code at the door, see exactly how many people are ahead of them and roughly how long it
will take, and their phone buzzes when they're two away.

No app to install. Works on any phone. Sinhala, Tamil and English.

**Live demo:** _coming soon_ · **Demo video (3 min):** _coming soon_

## Features

| Area | What is built |
|---|---|
| Tenants | Multi-tenant schema — `tenantId` on every table and in every `WHERE` clause |
| Tokens | **Gap-free, duplicate-free numbering under concurrency** (row lock + unique constraint + same-transaction capacity check) |
| Staff | "Call next" that calls exactly one patient from any number of devices; idempotency on every state-changing action |
| State | Token state machine — `WAITING → CALLED → SERVING → DONE / NO_SHOW / CANCELLED` — enforced in one file |
| Patients | Self-service tokens by QR, live position and ETA, sound + vibration alerts, one active token per device per queue |
| Display | Public TV display, trilingual, auto-reconnecting, built for a cheap Android TV browser |
| Realtime | SSE over Redis pub/sub, with heartbeats, backoff reconnect and a visible stale state |
| Reports | Median wait, median service time, no-show rate, CSV export (BOM, formula-injection guarded) |
| Extras | Thermal ticket printing (58/80mm), QR poster generator with a hand-rolled SVG encoder, daily reset by tenant timezone with no cron job |
| Auth & security | JWT access (15m, in memory) + refresh (7d, httpOnly, hashed, rotating with reuse detection), OWNER/STAFF roles, rate limiting, Joi config that refuses to boot on placeholder secrets |

## Stack

- **API:** NestJS 10 · TypeScript · Prisma 5 · PostgreSQL 16 · Redis 7 · Swagger/OpenAPI · Jest
- **Realtime:** SSE (`EventSource`) over Redis pub/sub — one-directional, auto-reconnecting, plain HTTP through any proxy
- **Web:** Next.js 14 App Router · TanStack Query · Zustand · Tailwind · lucide-react · si/ta/en
- **Infra:** Docker · docker-compose · GitHub Actions · multi-stage non-root images
- **Testing:** Jest unit · Supertest integration against **real** Postgres + Redis · Playwright E2E

## Architecture

```
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Staff console│  │  TV display  │  │Patient phone │  │Owner dashbrd │
  │  /console    │  │  /d/[slug]   │  │ /q/…  /t/…   │  │ /dashboard   │
  │  (tablet)    │  │ (Android TV) │  │  (QR scan)   │  │  (desktop)   │
  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘
         │                 │                 │                 │
         └────────┬────────┴────────┬────────┴─────────────────┘
                  │                 │
        JSON+JWT  │                 │  SSE (EventSource, text/event-stream)
                  │                 │
         ┌────────▼─────────────────▼──────────┐
         │      apps/web — Next.js 14          │
         │  App Router · Tailwind · TanStack   │
         │  Query · Zustand · si/ta/en         │
         └────────────────┬────────────────────┘
                          │  JSON + SSE
         ┌────────────────▼────────────────────────────┐
         │          apps/api — NestJS 10               │
         │                                             │
         │  auth · tenants · queues · tokens           │
         │  realtime · reports · public · health       │
         │                                             │
         │  idempotency · device cookie · rate limit   │
         └──────┬───────────────────────┬──────────────┘
                │ Prisma / $queryRaw    │ ioredis
                │                       │
      ┌─────────▼──────────┐   ┌────────▼─────────────┐
      │   PostgreSQL 16    │   │      Redis 7         │
      │                    │   │                      │
      │ tenants, users     │   │ pub/sub fan-out      │
      │ queues             │   │                      │
      │ queue_counters ◄── │   │ rate-limit windows   │
      │   THE LOCK ROW     │   │ slug→id cache        │
      │ tokens             │   │                      │
      │ idempotency_keys   │   │                      │
      │ audit_events       │   │                      │
      └────────────────────┘   └──────────────────────┘
         system of record          disposable
```

The structural rule the whole design rests on: **Postgres is the only system of record, and Redis is
allowed to disappear.** Token numbers are allocated under a Postgres row lock; idempotency records are
written in the same transaction as the action they guard; the capacity cap is a `COUNT` inside that
transaction. Flush Redis entirely and the clinic keeps issuing correct, gap-free numbers — displays
merely go stale until their `EventSource` reconnects. Everything Redis does therefore **fails open**.

Full write-ups: [docs/01-ARCHITECTURE.md](docs/01-ARCHITECTURE.md) · [docs/02-DATABASE.md](docs/02-DATABASE.md) · [docs/03-SECURITY.md](docs/03-SECURITY.md)

## Code excerpts (read-only)

| File | Why it is here |
|---|---|
| [samples/token-numbering/tokens.service.excerpt.ts](samples/token-numbering/tokens.service.excerpt.ts) | Token allocation: `SELECT … FOR UPDATE` on the counter row, the unique-constraint backstop, the same-transaction capacity check, and the first-token-of-the-day race handled explicitly |
| [samples/token-numbering/concurrency.e2e-spec.ts](samples/token-numbering/concurrency.e2e-spec.ts) | 30 concurrent issuers against a **real** PostgreSQL asserting exactly 1..30; 10 concurrent "call next" calling exactly one patient |
| [samples/token-state/token-state.ts](samples/token-state/token-state.ts) | The state machine as data, not scattered `if`s — and why `DONE → DONE` must be illegal |
| [samples/token-state/token-state.spec.ts](samples/token-state/token-state.spec.ts) | Exhaustive (status × action) tests, so the illegal transitions stay tested as actions are added |
| [docs/docker-compose.reference.yml](docs/docker-compose.reference.yml) | How the services are wired locally |

## Screenshots

| | |
|---|---|
| **The waiting-room TV** — `/d/[slug]`, trilingual, auto-reconnecting<br>![Display](screenshots/01-display.png) | **The patient's phone** — `/t/[publicId]`, live position and ETA<br>![Patient](screenshots/02-patient-phone.png) |
| **Nearly your turn** — sound + vibration alert<br>![Nearly](screenshots/03-patient-nearly.png) | **The staff console** — `/console`, thumb-zone primary action<br>![Console](screenshots/04-console.png) |
| **Owner dashboard** — served count, median wait, no-show rate<br>![Dashboard](screenshots/05-dashboard.png) | **Reports** — medians and CSV export<br>![Reports](screenshots/06-reports.png) |
| **The printable QR poster** — hand-rolled SVG encoder<br>![Poster](screenshots/07-qr-poster.png) | **Take a number** — what the patient sees after scanning<br>![Take token](screenshots/08-take-token.png) |

## The interesting problems

**Token numbers are gap-free and duplicate-free under concurrency.** Thirty patients can scan the QR code
at the same instant while staff issue a walk-in at the counter, and the numbers that come out are exactly
1..31. Three layers, each covering the one above: a **row lock** on `queue_counters (queue_id, service_date)`
taken with `SELECT … FOR UPDATE`, so concurrent issuers serialise in arrival order; **`UNIQUE (queue_id,
service_date, number)`** on `tokens` as the backstop, so a bypass is a database error rather than two
printed "A-014"s; and the capacity check in the **same transaction**, so a rejected token cannot have
consumed a number and left a gap.

Why not Redis `INCR`: Redis is not the system of record. A restart loses the last increments and the
counter goes *backwards*, minting duplicates. Even with a perfect Redis, the `INCR` and the `INSERT` are
two systems — a crash between them burns a number and leaves a gap the display shows as a skipped patient.
And rollback is impossible: if the insert violates the daily cap, the number is already spent.

**The genuine race, handled rather than hoped away.** Before the first token of the day, the counter row
does not exist — and `FOR UPDATE` cannot lock a row that is not there. Two concurrent first-issuers both
find nothing, both try to `INSERT`, the unique index lets exactly one win, and the loser catches `P2002`
and retries the locked read, which now finds the winner's row and blocks on it properly. The retry is
guaranteed to succeed, so there is no retry loop.

**"Call next" pressed on two tablets calls exactly one patient.** The lock is on the **queue** row, not the
token, because the race is in *choosing* which token — two transactions both choose before either has a
token to lock. Plus a conditional `UPDATE … WHERE status = 'WAITING'` that asserts the precondition it
decided on. Plus an **idempotency key** on every state-changing action, so a double-tap on one tablet
replays the first response instead of calling a second patient. The idempotency record is written in the
*same transaction* as the state change — which is exactly why it lives in Postgres and not Redis.

**A state machine in one file.** The interesting rules are the illegal ones. `DONE → DONE` is rejected
because it would re-stamp `completedAt`, corrupting the rolling service-time average, which is what every
waiting patient's ETA is computed from. A double-tap on a tablet would put a wrong number on strangers'
phones. The rulebook is *data*, not a `switch`, so the unit tests walk every (status, action) pair and
assert the legal set is exactly the table — a test that cannot drift from the implementation.

**SSE, not WebSockets.** The traffic is one-directional: the server tells displays and phones what changed,
and they never push back. `EventSource` reconnects on its own with no client library, it is plain HTTP so
it survives any proxy or captive portal, and it works on the cheap Android TV browser that is the actual
deployment target. A WebSocket would buy a duplex channel nothing needs, in exchange for reconnection logic
written by hand.

**Tests that need a real database.** The concurrency suite fires requests with `Promise.all` against real
Postgres and Redis, because the thing under test is `SELECT … FOR UPDATE` and a unique constraint — neither
of which exists in a mock. A mocked version of those tests would pass against code with no locking
whatsoever, which is precisely the bug they exist to catch. A sequential loop would too.

## Status & roadmap

Working end to end — multi-tenant schema, gap-free numbering under concurrency, idempotent staff actions,
the token state machine, QR self-service tokens, counter issuance with thermal ticket printing, SSE
realtime, the trilingual public display, the patient phone page with alerts, the staff console, the owner
dashboard, reports with CSV export, the QR poster generator, JWT auth with refresh rotation and reuse
detection, daily reset by tenant timezone, retention sweeps, and Swagger at `/docs`.

Deliberately not in v1, and designed for rather than built: SMS / WhatsApp notifications (the hook exists,
phone numbers are already hashed), billing and subscriptions (`tenants.plan` and a `features` JSON are in
the schema), appointments and booking, multi-branch under one owner, and a Go fan-out service for realtime
— the phase-2 answer if displays ever exceed a few thousand concurrent connections. A clinic has three.

## Access to full source

Interviewers / hiring managers: email me and I will add you as a **read-only collaborator** on the private repo for the
duration of the process.
