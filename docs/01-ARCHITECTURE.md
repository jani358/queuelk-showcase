# 01 — Architecture

QueueLK is a multi-tenant queue and token management system. A clinic, salon, bank branch
or government counter defines its queues; patients take a numbered token — from a QR code on
their own phone or from staff at the desk — and a live TV display plus a phone page tell
everyone where the line actually is. Staff stop shouting numbers.

This document explains what each piece is, why it exists, exactly what happens over the
life of one token from the door to "done", and what was rejected along the way.

---

## 1. What QueueLK is, and who it is for

The product in one sentence: **replace the paper slip and the shouted number with a live
number on a screen and on the patient's phone.**

The problem it was built for is concrete and local. In a Sri Lankan dispensary two or three
doctors see patients in turn. A patient arrives, takes a paper token numbered 41, and then
has no way at all to know whether the queue is at 12 or at 40. Two outcomes follow, and
both are bad:

1. **They sit.** Two hours in a plastic chair, because leaving means risking their turn.
2. **They wander off** to the shop or the bank, come back, and find that 41 was called
   eleven minutes ago and the counter has moved on. Now there is an argument.

Meanwhile the staff member's actual job for the whole session is shouting "හතළිස් එක!"
across a room with a fan running.

The three customer types the design was aimed at, all Sri Lankan, all small:

| Customer | Queues | What the display shows | Why they'd pay |
|---|---|---|---|
| A dispensary (medical clinic) | Dr. Perera (A), Dr. Silva (B), Pharmacy (PH) | Now serving A-014 · B-009 · PH-031 | Patients stop crowding the counter to ask "how many more?" |
| A salon | Two chairs, walk-ins | Now serving 007, next 3 | Customers go get a coffee and come back on time |
| A bank branch / govt. counter | Cashier, new accounts, pensions | Counter-by-counter, trilingual | A visible, disputable-free order of service |

Three facts about that customer set drive nearly every decision below:

1. **The hardware is cheap and the network is unreliable.** The display is a Rs 25,000
   Android TV running a browser in a waiting room with clinic wifi. The staff console is a
   ten-year-old Android tablet. Anything requiring a modern runtime, a persistent
   bidirectional socket, or hand-rolled reconnection logic will fail in that room and I
   will not be there to debug it.
2. **The number is a promise.** A patient holding a slip that says A-041 has been promised
   that 40 people come before them and nobody after them jumps the line. If two slips ever
   say A-014, or the display jumps from 14 to 16, the product is finished — not because of
   a stack trace, but because the customer saw it happen with their own eyes. §5 and
   `02-DATABASE.md` §4 are entirely about this one promise.
3. **They are small and price-sensitive.** A dispensary has three displays and maybe 120
   tokens a day. A design needing Kafka, a service mesh, and a separate realtime tier to
   move ~120 events a day is not a product; it is a hobby with a hosting bill.

"Multi-tenant" means one deployment, one database, one process serves every clinic, with
isolation enforced in the `WHERE` clause of every query rather than by separate
deployments. "Trilingual" means the public surfaces render in Sinhala, Tamil and English —
`Tenant.languages` is an ordered array and the display rotates through it, because the
waiting room genuinely contains all three.

---

## 2. System overview

Nine boxes. This is the whole thing, and it should take about two minutes on a whiteboard.

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
      │ queues             │   │   qlk:t:<id>         │
      │ queue_counters ◄── │   │   qlk:t:<id>:q:<q>   │
      │   THE LOCK ROW     │   │   qlk:t:<id>:tok:<p> │
      │ tokens             │   │                      │
      │ idempotency_keys   │   │ rate-limit windows   │
      │ audit_events       │   │ slug→id cache        │
      └────────────────────┘   └──────────────────────┘
         system of record          disposable
```

The one structural rule worth stating up front, because it is what makes this design
defensible rather than merely small: **Postgres is the only system of record, and Redis is
allowed to disappear.** Token numbers are allocated under a Postgres row lock. Idempotency
records are written in the same Postgres transaction as the action they guard. The daily
capacity cap is a `COUNT` inside that transaction. Flush Redis entirely and the clinic keeps
issuing correct, gap-free, duplicate-free numbers — displays merely go stale until their
`EventSource` reconnects and refetches.

That rule has a direct corollary which shows up all over the code: **anything Redis does,
fails open.** The rate limiter catches its own errors and allows the request
(`rate-limit.guard.ts`); `RedisService.publish` swallows failures and logs;
`QueuesService.broadcast` wraps the whole publish in a try/catch. None of those can take the
waiting room offline, because none of them is load-bearing for correctness.

---

## 3. Why each component exists

### apps/api — NestJS 10 + Prisma

The system of record and the only thing that talks to Postgres or Redis. Modules map to the
whiteboard boxes:

| Module | Responsibility | Why it is its own module |
|---|---|---|
| `auth` | Staff register/login, JWT access + refresh rotation with reuse detection, `JwtAuthGuard` global, `RolesGuard` by rank | The security surface concentrated in one reviewable place. The guard is global and endpoints opt out with `@Public()`, so a new endpoint is protected unless someone explicitly opens it — fail-closed |
| `tenants` | Clinic settings: slug, branding, `languages`, `ticketFooter`, **`timezone`** | Tenant root — every other row hangs off `tenantId`, and `timezone` is what `serviceDate` is computed in, so it is not a cosmetic settings field |
| `queues` | Queue CRUD, `QueueSnapshot` (now-serving / up-next / waiting count), `serviceDate`, ETA | The read model. One `snapshot()` used by console, display and patient page so those three **cannot disagree** about what "now serving" means |
| `tokens` | Issue, call-next, act (RECALL/START/DONE/SKIP/NO_SHOW/CANCEL), the state machine, the numbering lock | The write path, and the only place that mutates `Token.status`. Concentrating it is what makes the invariant reviewable in one file |
| `realtime` | Redis pub/sub publish, channel naming, `SseWriter` | The fan-out. Separated because its failure semantics are the opposite of everything else's — it is allowed to drop messages, and that must be visible in the module boundary |
| `reports` | Daily stats, no-show rate, rolling service average, CSV export | Different access pattern (range scans over historical `serviceDate`s) from the live hot path, and different latency budget |
| `public` | Unauthenticated: `GET /public/t/:publicId`, `POST /public/queues/:id/tokens`, the SSE endpoints, the display payload | **The blast-radius boundary.** Everything reachable without a JWT is in one folder, so "what can an anonymous stranger do" is a question with a file-system answer |
| `health` | Liveness/readiness with real Postgres and Redis probes | A load balancer needs a true answer, not `200 OK` from a process that lost its database. `RedisService.isHealthy()` actually PINGs |

NestJS earns its place for the same reason it does anywhere the structure is the selling
point: guards, interceptors, middleware ordering and DI are first-class. `DeviceMiddleware`
must run before `RateLimitGuard` so the guard can key by device, and in Nest that ordering
is a framework guarantee rather than a convention someone has to remember.

### apps/web — Next.js 14 App Router

Four surfaces, one app, four genuinely different rendering needs:

| Surface | Route | Rendering | Why |
|---|---|---|---|
| Staff console | `/console` | Client, behind auth | Highly interactive, mutation-heavy, no SEO. TanStack Query holds server state; Zustand holds the small amount of UI state (selected queue tab, confirm dialogs) that is genuinely local |
| TV display | `/d/[slug]` | Server-rendered shell + SSE | Must paint a correct number on first load with no spinner, then never touch the network again except the stream. It runs unattended for twelve hours |
| Patient phone | `/q/[slug]/[queue]`, `/t/[publicId]` | Server-rendered + SSE | Arrived at by QR scan from outside the site, so first paint and linkability matter. `/q/…` is "take a token here", `/t/…` is "this is your token" |
| Owner dashboard | `/dashboard` | Client, behind auth | Charts and date ranges; nobody links to it |

One framework gives all four without a second build pipeline, and — the concrete reason —
the display and the phone page share the same `QueueSnapshot` type and the same SSE event
shapes as the console, so a change to `nowServing` semantics cannot land on one surface and
not another.

The trilingual story is a `languages` array on the tenant plus dictionaries in the web app.
The display **rotates** through the tenant's languages on a timer rather than picking one,
because a Colombo waiting room contains Sinhala, Tamil and English readers at the same time
and choosing for them is the wrong call. The phone page defaults to the first language and
offers a switcher, because there the reader is one identifiable person.

### PostgreSQL 16

The system of record, and specifically the place where the **numbering invariant** lives.
`SELECT ... FOR UPDATE` on a `queue_counters` row is a boring, forty-year-old feature that
does exactly the right thing, and the entire "why not Redis INCR" argument in §7 is really
an argument that this boring feature is the correct tool.

It also holds the idempotency records, which is not a detail: they must be **exactly as
durable as the action they guard**, and the only way to guarantee that is for both writes to
be in the same transaction. Nothing outside Postgres can participate in a Postgres
transaction, which decides the question.

### Redis 7

Three jobs, with three different failure tolerances, all documented at the top of
`redis.service.ts`:

| Use | Why Redis | What happens when it's down |
|---|---|---|
| **Pub/sub fan-out for SSE** | The reason Redis is here at all. A display connected to pod B must learn about a "call next" handled by pod A | Displays go stale; they show a "reconnecting" badge and fall back to polling `/public/queues`. Clinic keeps working |
| Rate limiting (sliding window, one Lua script) | Atomic read-modify-write on a sorted set, with free expiry. A fixed window lets a caller send `limit` at 00:59 and `limit` again at 01:00 | **Fails open** — the request is allowed. Safe only because the limits that protect correctness (`dailyCapacity`, one-token-per-device) are Postgres-side |
| Slug → tenant id cache | Every public request resolves a slug; this is a hot, tiny, read-only lookup | One extra indexed read per request |

Nothing in Redis is the source of truth. That is a design constraint, not an observation:
the moment a token number depended on Redis, a Redis restart would become a duplicate slip.

**Two Redis connections, not one.** A connection in subscriber mode accepts only
`(P)SUBSCRIBE`/`UNSUBSCRIBE`/`PING`/`QUIT`; every other command errors. Sharing one
connection would break every `GET` and `EVAL` the moment the first display connected. That
is protocol, not optimisation.

**Subscriptions are reference-counted** per channel (`RedisService.subscribe`). Twenty
displays on one pod watching one tenant share a single Redis `SUBSCRIBE`, and the
`UNSUBSCRIBE` only fires when the last local listener leaves. Without the counting, one
display closing its tab would unsubscribe the channel out from under every other display on
the same pod — a bug that only appears with more than one viewer, which is to say in
production.

### The device cookie

Not a session. `qlk_device` is 16 random bytes plus an HMAC-SHA256 signature, formatted
`<idHex>.<sigBase64url>`. No user id, no token id, no timestamp. It is a pseudonym.

It exists because "one active token per device per queue" and the per-device rate limit need
*something* stable to key on, and a medical clinic must not be handed a login wall at the
door. Signing it matters: without a signature an abuser sets `qlk_device=anything` and mints
a fresh identity per request with a header, which is trivially scriptable. With one, each
identity costs a real round trip, which is what makes the IP limit bite.

**Stated plainly, because pretending otherwise is how holes ship:** clearing cookies or
opening a private window yields a new identity for free. The device cookie raises the cost
of casual abuse. The hard limits are `Queue.dailyCapacity`, enforced inside the issuing
transaction, and the per-IP window.

`sameSite: 'lax'`, not `'strict'` — the patient arrives by scanning a QR code, which is a
top-level navigation from outside the site, and `'strict'` would withhold the cookie on
exactly that first request and mint a new device on every single scan.

---

## 4. The full life of one token

This is the walkthrough to be able to give from memory. Follow the numbers; every hop has a
"what could go wrong" underneath.

```
 Phone       Next.js      NestJS API        Postgres        Redis      Display
   │            │             │                 │             │           │
 1 │ scan QR ──►│             │                 │             │           │
   │ /q/sunrise/A             │                 │             │           │
   │            │ GET /public/queues ──────────►│             │           │
   │◄─ SSR page + snapshot ───┤                 │             │           │
   │            │             │                 │             │           │
 2 │      DeviceMiddleware: no qlk_device cookie │             │           │
   │      → issue() = 16B CSPRNG + HMAC          │             │           │
   │◄─ Set-Cookie: qlk_device=…; HttpOnly; Lax ──┤             │           │
   │            │             │                 │             │           │
 3 │ tap "Take a token" ─────►│                 │             │           │
   │ POST /public/queues/:id/tokens             │             │           │
   │ Idempotency-Key: <uuid>  │                 │             │           │
   │            │             │                 │             │           │
 4 │      RateLimitGuard ─────────────────────────────────────►│ ZADD Lua │
   │      (per device / per IP; FAILS OPEN)      │             │           │
   │            │             │                 │             │           │
 5 │      IdempotencyService.run — SELECT idempotency_keys ───►│           │
   │      hit? replay stored body, STOP.         │             │           │
   │            │             │                 │             │           │
 6 │      ┌──── BEGIN ───────────────────────────►│           │           │
   │      │ SELECT id FROM queues … FOR UPDATE   │            │           │
   │      │ queue.status must be OPEN            │            │           │
   │      │ serviceDate(tenant.timezone) → date  │            │           │
   │      │ device already holds an ACTIVE token?│            │           │
   │      │ dailyCapacity COUNT check            │            │           │
 7 │      │ ★ SELECT last_number FROM queue_counters          │           │
   │      │     WHERE queue_id=$1 AND service_date=$2         │           │
   │      │     FOR UPDATE          ← THE LOCK   │            │           │
   │      │   next = last_number + 1             │            │           │
   │      │   UPDATE queue_counters SET last_number = next    │           │
 8 │      │ INSERT INTO tokens (…, number, publicId)          │           │
   │      │   UNIQUE(queue_id, service_date, number) backstop │           │
   │      │ INSERT INTO audit_events ('token.issued')         │           │
   │      │ INSERT INTO idempotency_keys (same tx!)           │           │
   │      └──── COMMIT ──────────────────────────►│           │           │
   │            │             │                 │             │           │
 9 │      broadcast(): snapshot → PUBLISH ──────────────────►│ qlk:t:…   │
   │            │             │                 │             ├──────────►│
   │◄─ 201 { publicId, label:"A-041", peopleAhead:12, eta } ──┤  waiting  │
   │            │             │                 │             │  count++  │
   │            │             │                 │             │           │
10 │ redirect to /t/<publicId>, open EventSource │             │           │
   │ GET /public/stream/token/<publicId> ───────►│ SUBSCRIBE ►│           │
   │◄─ retry: 3000 ── : hb ── : hb ──────────────┤             │           │
   │            │             │                 │             │           │
   ·            ·             ·        (twenty minutes)        ·           ·
   │            │             │                 │             │           │
11 │      staff tap "Call next" on the console   │             │           │
   │      POST /queues/:id/call-next  +Idempotency-Key         │           │
   │      ┌──── BEGIN ───────────────────────────►│           │           │
   │      │ SELECT id FROM queues … FOR UPDATE   │            │           │
   │      │ SELECT … WHERE status='WAITING'      │            │           │
   │      │   ORDER BY number ASC LIMIT 1        │            │           │
12 │      │ ★ UPDATE tokens SET status='CALLED', called_at=now│           │
   │      │     WHERE id=$1 AND tenant_id=$2     │            │           │
   │      │       AND status='WAITING'  ← conditional         │           │
   │      │   count === 0 → 409, never a silent success       │           │
   │      │ INSERT audit_events ('token.called') │            │           │
   │      │ INSERT idempotency_keys              │            │           │
   │      └──── COMMIT ──────────────────────────►│           │           │
   │            │             │                 │             │           │
13 │      PUBLISH qlk:t:<tenant>:tok:<publicId> ────────────►│           │
   │      PUBLISH qlk:t:<tenant> (+ :q:<queueId>) ──────────►├──────────►│
   │◄─ event: token.changed {status:"CALLED"} ───┤             │  A-041    │
   │  phone vibrates, page turns green           │             │  in 60pt  │
   │            │             │                 │             │           │
14 │      staff tap START → SERVING, served_at stamped        │           │
15 │      staff tap DONE  → DONE, completed_at stamped        │           │
   │      (if still CALLED, an implicit START runs first)     │           │
   │      → the (completed_at − served_at) sample joins the   │           │
   │        rolling median that every other patient's ETA uses│           │
```

### Hop by hop: what happens, and what could go wrong

**1 — The QR scan.** The QR encodes `https://queuelk.lk/q/<slug>/<queuePrefix>`. The page is
server-rendered with a fresh `QueueSnapshot` so the patient sees the real waiting count
before any JavaScript runs. *What could go wrong:* the slug does not resolve — 404, and the
poster on the wall is stale. This is why slugs are never recycled.

**2 — Device cookie minted.** `DeviceMiddleware` runs before guards, verifies any existing
cookie with a constant-time compare, and mints one if absent. A tampered cookie is treated
as "no device" and replaced rather than rejected — rejecting would let anyone break a
patient's page by planting a junk cookie. *What could go wrong:* the patient's browser
blocks cookies. Then they get a fresh device every request, the per-device limit never
bites, and only the IP window and `dailyCapacity` protect the queue. Accepted.

**3-4 — Rate limit.** Sliding window in one Lua script, so `ZREMRANGEBYSCORE` / `ZCARD` /
`ZADD` cannot interleave. Identity precedence is user → device → IP; **IP is last** because
in a Sri Lankan clinic the whole waiting room is behind one router and mobile users are
behind carrier-grade NAT shared by thousands. Limiting primarily by IP would punish the
honest crowd to inconvenience one abuser. *What could go wrong:* Redis is down. It fails
open, deliberately, and §8 explains why that is safe here and would not be in a different
system.

**5 — Idempotency pre-check.** `SELECT` on `(tenantId, key)`. A hit with the same endpoint
and the same body hash replays the stored response verbatim and does not run the action. A
hit with a *different* body is a 409 — that is a client bug (a key generator that repeats),
and returning the first response would report success for an action that never happened.
*What could go wrong:* two requests with the same key arrive close enough that both pass
this check. Handled — see §6.

**6 — The queue lock and the pre-conditions.** `SELECT id FROM queues … FOR UPDATE`. Then
`queue.status === OPEN`, then `serviceDate(tenant.timezone)`, then the one-active-token-per-
device check, then the `dailyCapacity` count. All four are **inside the transaction**, which
is the entire point: the device check lives here and not only in the Redis limiter because
the limiter fails open, and "Redis is down" must never become "anyone can mint unlimited
tokens".

**7 — The number is allocated.** The row lock. This is §5 and `02-DATABASE.md` §4.
*What could go wrong:* it is the first token of the day and the counter row does not exist —
`FOR UPDATE` cannot lock a row that is not there, so two concurrent first-issuers both find
nothing and both try to `INSERT`. The unique index lets one win; the loser catches `P2002`
and retries the locked read, which now finds the winner's row and blocks on it properly.
That retry is guaranteed to succeed, so there is no retry loop.

**8 — The INSERT, and everything else, in one transaction.** Token row, audit row,
idempotency row. If any of them fails, the number is not consumed. A design that allocated
the number outside the transaction could not offer that.

**9 — Publish, AFTER commit.** `QueuesService.broadcast` runs outside the transaction on
purpose. Publishing inside would announce a token that could still roll back, and a display
would show a number that never officially existed. The publish is wrapped in try/catch: a
broadcast failure must never fail the action that caused it, because the state change is
already committed and throwing would make staff press the button again — which is precisely
the bug the whole concurrency design exists to prevent.

**10 — The phone opens an SSE stream.** `retry: 3000` is sent explicitly rather than
inherited from the browser default, because the reconnect behaviour of a waiting-room
display is a product decision: fast enough that a brief wifi drop is invisible, slow enough
that a restarting API is not hammered by every screen in the building at once. A heartbeat
comment every 20s keeps nginx (60s idle) and Cloudflare (100s) from closing the connection.

**11-12 — Call next.** The interesting concurrency case, and it is a genuinely different
problem from issuing. Two staff tablets press the button at the same moment. Both read the
same oldest `WAITING` token; both mark it `CALLED`; or with a slightly different interleaving
they call two *different* patients while the display shows one. A patient loses their turn
and nobody can see why.

Two mechanisms, and the reason there are two is worth being precise about:

- **The lock is on the QUEUE row, not the token.** The race is in *choosing* which token,
  and two transactions choose before either has a token to lock. Locking the token would be
  locking the wrong thing, after the fact.
- **The write is a conditional `updateMany`** with `WHERE id = ? AND tenantId = ? AND status
  = 'WAITING'`, and the affected-row count is checked. `update` matches on the primary key
  only and would happily overwrite a token another path had already moved. With the queue
  lock held, `count === 0` should be unreachable — it is checked anyway, because a silently
  zero update would return a "called" response for a patient who was never called.

Idempotency covers the third case, which neither of those can: **one tablet, tapped twice.**
A retry is a legitimately separate request; no lock can distinguish it from a second
intentional action. Only a client-supplied key can.

**13 — Two publishes, two channels.** `token.changed` goes to
`qlk:t:<tenant>:tok:<publicId>` — the patient's phone and nobody else's. `queue.changed`
goes to both `qlk:t:<tenant>:q:<queueId>` (phones watching that queue's position) and
`qlk:t:<tenant>` (the display, which shows every queue on one screen and would otherwise
need one subscription per doctor). The split exists so a patient's phone does not re-render
— or vibrate — for every other patient's movement.

`queue.changed` carries `nowServing`, `upNext` and `waitingCount` so the display can update
the big number **without a round trip**. It deliberately does *not* carry the full token
list: twenty displays each refetching 40 tokens on every "call next" is a thundering herd
for a number that fits in 30 bytes.

**14-15 — START and DONE.** `servedAt` opens the service measurement, `completedAt` closes
it, and `completedAt − servedAt` becomes one sample in the rolling median that every waiting
patient's ETA is computed from. If staff never press START — and many clinics never will —
`TokensService.act` inserts the missing `CALLED → SERVING` transition rather than weakening
the state machine to allow `CALLED → DONE`. The model stays truthful; the console stays one
tap. The cost is a near-zero-length service sample, which `usableSamples` discards as
implausible (below 20 seconds), so it cannot skew the estimate.

---

## 5. The numbering invariant, in architectural terms

The database document argues this in full depth (`02-DATABASE.md` §4). The architectural
summary, because it is the decision the whole system is shaped around:

> For a given `(queue, serviceDate)`, the numbers issued are exactly `1..N` — no gaps, no
> duplicates — no matter how many patients scan the QR at the same instant as staff press
> "Issue" at the counter.

Three layers, each covering the one above:

| Layer | Mechanism | Covers |
|---|---|---|
| 1 | `SELECT last_number … FOR UPDATE` on the `queue_counters` row | Concurrency. Postgres serialises issuers on one row, in arrival order |
| 2 | `UNIQUE (queue_id, service_date, number)` on `tokens` | A bug, a migration, or a manual `INSERT` during support that bypasses layer 1 |
| 3 | The same transaction enforces `dailyCapacity` | A rejected token cannot have consumed a number |

Layer 3 is the one people miss, and it is the reason the design is transactional rather than
just locked. An "allocate from Redis, then insert" design cannot roll back the allocation:
the number is already spent, and the display shows a gap the clinic reads as a skipped
patient.

A constraint that has never fired is not wasted. Layer 2 is the reason the worst case is a
409 rather than two patients standing at one counter holding identical slips.

---

## 6. Idempotency: the third concurrency problem

Locks solve "two devices at once". They cannot solve "one device, twice", because a retry is
by construction a separate request that the server has no way to distinguish from a second
intentional press.

The scenario is concrete: a ten-year-old Android tablet on clinic wifi, staff taps "Call
next", the response takes three seconds, they tap again. Without protection two patients are
called; the second is standing at a counter nobody is expecting them at, and the first has
lost their place.

The contract:

| Case | Result |
|---|---|
| First request with `(tenantId, key)` | Action runs, response stored, response returned |
| Retry, same key, same endpoint, same body hash | Stored response returned verbatim. Action does **not** run again. Not an error — from the client's point of view the first request simply succeeded |
| Same key, different body or endpoint | 409. A key generator that repeats is a client bug, and replaying the first response would report success for something that never happened |
| No key supplied | Runs unprotected. Deliberate: the API stays usable from curl and Swagger, and a missing key is the caller's risk. The web console always sends one |

**Why Postgres and not Redis.** The idempotency record must be exactly as durable as the
action it guards. If Redis loses the key after a restart, a retry re-executes "Call next"
and the thing this was built to prevent happens anyway. The row is written in the **same
transaction** as the state change, so they commit or roll back together. That atomicity is
the whole design, and Redis cannot participate in a Postgres transaction.

**The race the pre-check cannot close.** Two requests with the same key arrive close enough
that both pass the `findUnique`. Both enter transactions; one wins the unique index, the
loser catches `P2002`. The correct answer is not an error — the action *did* happen, once —
so the loser reads the winner's stored response and returns that. This is the difference
between idempotency that works under load and idempotency that works in a demo.

**Body hashing is order-stable.** Keys are sorted before hashing, so `{a:1,b:2}` and
`{b:2,a:1}` hash identically. Otherwise a client whose JSON serialiser reorders keys between
attempts gets a spurious 409 on a retry that is genuinely the same request.

---

## 7. Trade-offs consciously rejected

### WebSockets instead of SSE

The fashionable answer, and the wrong one here. The full argument lives at the top of
`sse-writer.ts`:

| | SSE | WebSocket |
|---|---|---|
| Direction | Server → client only | Full duplex |
| Protocol | Plain HTTP `text/event-stream` | Upgrade handshake |
| Reconnect | Built into `EventSource`, server-tunable via `retry:` | Hand-rolled |
| Proxies / CDNs / corporate filters | An ordinary HTTP response | Frequently blocked or mishandled |
| Auth | Normal cookies and headers | Awkward; usually a token in the query string |
| Server state | None — it is a long response | A connection registry to manage |
| Debuggable with `curl` | Yes | No |
| Android TV from 2016 | `EventSource` shipped ~2011 | Works, but the reconnect code is mine to write |

**The traffic is one-directional.** A TV display and a patient's phone are pure readers;
they never send a byte up this channel. Every staff action is an ordinary authenticated
`POST`. A WebSocket would buy a bidirectional link at the cost of a second protocol, a
second auth path, a second set of proxy configuration and its own reconnection logic — to
carry zero bytes upstream.

**SSE reconnects itself.** A WebSocket that drops stays dropped until application code
notices and rebuilds it — code that has to be written, tested, and then debugged on a cheap
Android TV in a clinic I visit once a month.

The honest cost: one held-open HTTP connection per client, and the six-per-origin cap on
HTTP/1.1. Irrelevant here — a display opens exactly one, and any real deployment is behind
HTTP/2 where the cap does not apply.

The real scar is `X-Accel-Buffering: no`. Without it nginx buffers the stream until it has a
full chunk, and the display updates seconds late or in bursts. Nothing errors. It is the
single most common "SSE works locally, not in production" bug, and it is invisible in
development because there is no nginx there.

### In-process events instead of Redis pub/sub

Works perfectly on one machine and fails invisibly the day a second one is added — the worst
possible failure mode, because it is a *scaling* change that silently breaks correctness. A
display connected to pod B would simply never learn about a "call next" handled by pod A,
with no error anywhere. Redis pub/sub is the smallest thing that makes the fan-out
pod-count-independent.

### Redis Streams or Kafka instead of pub/sub

Those exist to guarantee delivery and enable replay. **Neither is wanted here.** A missed
"A-014 called" is worthless three seconds later — by then the display needs A-015. Every
event is a full snapshot of current state, so a client that missed one gains nothing from
receiving it late; it wants *current* state, which it gets from its reconnect fetch. Paying
for durability we actively do not want would be complexity with a negative return.

### A Go realtime service now

The instinct is right and the timing is wrong.

Node holding thousands of idle SSE connections is genuinely not its best shape: each one is
a socket, a `Response` object, a heartbeat timer and its share of the event loop. Go's
goroutine-per-connection model is a better fit, and I would reach for it.

**A clinic has three displays.** Three displays plus, on a busy morning, perhaps sixty
phones. That is sixty-three connections and roughly 120 state changes a day. Building a
second service, a second deployment, a second health check and a second set of logs to carry
that is not engineering; it is résumé-driven architecture.

**The phase-2 trigger is explicit:** a few thousand concurrent connections, or SSE
connection count showing up in API latency percentiles. And the migration is genuinely
small, because it was designed to be — the Go service subscribes to **the same Redis
channels** (`qlk:t:<tenantId>`, `…:q:<queueId>`, `…:tok:<publicId>`), serves the same
`text/event-stream` with the same event names, and the API does not change at all. The
browser code does not change either, because the URL is the only thing that moves. The
channel-name scheme being a stable, documented contract rather than an implementation detail
is what keeps that true.

### Polling instead of SSE

Considered seriously, because it is simpler and I nearly shipped it.

At a 3-second poll, three displays and sixty phones make ~1,260 requests per minute, each
one running the full `snapshotFor` query set — for a queue that changes maybe 120 times a
day. That is roughly 99.99% wasted work. Worse, it is wasted work with a *latency floor*:
the big number on the wall would update up to three seconds after staff pressed the button,
in a room where the staff member and the screen are both visible to the patient at once.
That delay is exactly the thing the product is selling against.

Polling survives as the **fallback**, and that is the right place for it: when SSE drops,
the display shows a "reconnecting" badge and polls `/public/queues` until the stream comes
back. The degraded path is correct and visible, which is the property that matters.

### Redis INCR for numbering

The obvious "faster" answer and the one this whole system is shaped to avoid. Three
independent reasons, any one of which is disqualifying:

1. **Redis is not durable enough to be a counter of record.** A restart with default RDB
   snapshotting loses the last seconds of increments and the counter goes *backwards*,
   minting duplicate numbers. AOF `everysec` still loses up to a second. AOF `always` is
   slower than the Postgres row lock it was supposed to replace.
2. **`INCR` and `INSERT` are two systems.** A crash between them burns a number and leaves a
   gap. "Why does the display jump from 14 to 16?" is a question a clinic will ask, and
   "distributed systems" is not an answer they will accept.
3. **Rollback is impossible.** If the `INSERT` then violates `dailyCapacity`, the Redis
   number is already spent. `DECR` is not a safe undo under concurrency — another issuer may
   have incremented in between.

The lock costs a few milliseconds on a row contended by at most a handful of people standing
at a door. That is the correct trade for an invariant a customer can verify with their own
eyes on a paper slip.

### A separate `token_events` table instead of timestamp columns

`issuedAt`, `calledAt`, `servedAt`, `completedAt` are four columns on `tokens` rather than
rows in an events table. Each is the only source for one reported metric:
`waitSeconds = calledAt − issuedAt`, `serviceSeconds = completedAt − servedAt`.

**What an events table would buy:** full per-transition history, including every `RECALL` and
every `SKIP`, and the ability to answer "what was the state at 14:32 yesterday".

**What it would cost right now:** every read of a token's current state becomes an aggregate
over its events, or a projection that must be kept in sync. The ETA query — which runs on
every patient page load — goes from "select two columns from the last ten DONE rows" to a
windowed aggregate. And `audit_events` already records every transition with `from`/`to` in
its `meta`, so the audit need is met; what is missing is only the *efficient queryability*
of that history.

**When I would switch:** when per-transition analytics become a product feature rather than
a support tool, or when `recallCount` stops being enough to answer "why did this patient
wait so long". It is an additive migration — the columns can stay as a materialised
convenience — not a redesign.

### Serverless (Vercel functions / Lambda) for the API

Rejected on two structural grounds, not on cost.

**SSE needs a long-lived process.** A display holds one connection open for twelve hours.
Serverless platforms cap execution duration and bill by it; a twelve-hour streaming response
is the shape those platforms exist to avoid.

**Connection pooling.** The numbering design depends on `SELECT … FOR UPDATE` inside a
transaction, and a fleet of short-lived function instances each opening its own Postgres
connection is the classic way to exhaust a small database. The fix is a pooler, and
transaction-mode pooling plus session-scoped locks is a combination that needs care. A
long-lived Node process with one Prisma pool avoids the entire category.

### Row-Level Security instead of `tenantId` in every `WHERE`

RLS would enforce isolation in the database itself, which is strictly stronger than
discipline at every call site. It is not used because it requires a per-request
`SET LOCAL app.tenant_id`, which interacts badly with transaction-mode connection pooling —
a pooled connection carrying the previous request's setting is a serious failure mode, and
the wrong direction to fail in — and because Prisma has no first-class support for it.

The honest position: **the current approach depends on discipline, and RLS would not.** The
mitigation is that every service method takes `tenantId` as its first parameter, so there is
no version of the query without it — see `QueuesService.findOne`. It is the security
improvement I would make first if this took payment data or grew a team.

---

## 8. Failure modes

What actually happens, and what the person in the waiting room sees.

| Failure | What breaks | What still works | What the user sees | Recovery |
|---|---|---|---|---|
| **Redis down** | Pub/sub fan-out, rate limiting, slug cache | **Everything that matters.** Issuing, calling, the state machine, `dailyCapacity`, one-token-per-device, idempotency — all Postgres | Display shows a "reconnecting" badge and falls back to polling `/public/queues`; numbers are a few seconds stale, never wrong. Rate limits stop applying (fail-open) | Automatic. `retryStrategy` backs off to 3s; `subscriber.on('ready')` re-subscribes every known channel |
| **Postgres down** | Everything | Nothing | Staff console shows an error on every action; display keeps rendering its last snapshot and marks itself stale | Manual. `/health` readiness fails so the load balancer stops routing. This is the single point of failure and it is named as such |
| **Display loses wifi** | That one display | Every other surface | Heartbeat gap exceeds threshold → "reconnecting" badge. The screen says it is stale rather than **lying with a frozen number**, which is the whole reason the heartbeat exists | `EventSource` retries every 3s; on reconnect it refetches the snapshot and paints current state |
| **API pod restarts** | Every SSE connection on that pod drops | Postgres state is untouched; other pods are unaffected | A ~3 second blank on the display, then current state | Automatic. `heartbeat.unref()` means a graceful `docker stop` is not held open for the full timeout by idle displays |
| **Two staff devices call next at once** | Nothing | Everything | One patient is called, once. The second device gets that same patient in its response, or a 409 telling it to refresh | Queue row lock + conditional `updateMany`. §4 hop 11-12 |
| **One staff device, double tap** | Nothing | Everything | The second tap returns the first tap's response verbatim | Idempotency key, stored in the same transaction. §6 |
| **Slow/dying SSE client** | That one connection | Everything | The connection is closed and reconnects | `res.write()` returning `false` means the kernel buffer is full. Since every event is a full snapshot, a slow client gains nothing from a backlog — so the stream is dropped rather than queueing in userland and leaking memory |
| **Malformed pub/sub message** | One message | Everything | Nothing | `RealtimeService.subscribe` catches the `JSON.parse` and logs. One bad publish must not take every display on the pod offline |
| **A listener throws** | Nothing | Everything | Nothing | `RedisService` wraps each listener call. One broken display must not stop the others receiving the event |
| **Invalid tenant timezone** | Nothing | Everything | The service-date boundary may be wrong for that tenant | `formatterFor` falls back to `Asia/Colombo`. A clinic running with a possibly-wrong boundary is strictly better than one that cannot issue tokens at all; the settings form validates the zone on the way in |

Two patterns run through that table and are worth naming:

**Degrade toward stale, never toward wrong.** Every fallback shows old information with a
visible staleness indicator. None of them shows a confidently wrong number. A display that
admits it is disconnected is honest; a display frozen on A-014 while the clinic serves A-022
is actively harmful.

**Nothing in the realtime path can fail an action.** `broadcast` catches. `publish` catches.
The listener loop catches. The reason is specific: if a publish failure surfaced as a 500 on
"Call next", staff would press the button again — and call two patients. The entire
concurrency design would be defeated by an error-handling decision three layers away.

---

## 9. What this does not handle

Stated because the gaps are more informative than the features.

**One Postgres, no replica.** It is the single point of failure and there is no automatic
failover. For a three-clinic deployment with nightly backups that is an honest trade; for
fifty clinics it is not, and a streaming replica plus a documented promotion procedure is
the first operational thing I would add.

**No SMS.** `phoneHash` and `phoneLast4` exist and the plaintext number is never stored,
which means the "you are next" SMS everyone asks for is *not shippable without a schema
change* — deliberately. v1 sends no SMS, so the plaintext has no use, and a database of
patient phone numbers at a medical clinic is the single worst thing in this system to leak.
Adding SMS means adding storage of a real number, which means encryption at rest and a
retention policy, and that should be a considered decision rather than a column that was
already there.

**No printer integration.** `ticketFooter` exists for a thermal ticket that nothing currently
prints. A counter that issues tokens today hands over a number read off a screen.

**The ETA cannot see closing time.** A patient 40th in line at 16:50 is told "3h 20m" rather
than "you will not be seen today". `dailyCapacity` is the mechanism that is supposed to
prevent that situation, and it is a blunt one. An honest scheduler would need session hours
per queue, which is a real feature and not a small one.

**The ETA cannot see no-shows or shared doctors.** No-shows make the queue faster than
predicted, so the estimate is simply conservative. A doctor covering two queues is invisible
to a model that measures per-queue throughput.

**No variance in the ETA.** An honest UI would say "20-35 minutes". v1 shows a point estimate
rounded to 5 minutes, on the theory that rounding communicates imprecision more simply than
an interval a patient has to interpret. That is a judgement, not a measurement.

**The device cookie is not an identity.** Private window, cleared cookies, second phone — all
free. §3 says this plainly and the hard limits are elsewhere.

**No load testing.** Every concurrency claim in this document is argued from first principles
and covered by an integration test that fires ten simultaneous issue requests. That is
enough to catch a missing `FOR UPDATE`; it is not enough to characterise behaviour at the
lock under a thousand concurrent issuers. **Like the evaluation-set gap in AskLK, this is
the honest weakness: the design is reasoned, not measured.**

**No display-side offline cache.** A display that boots with no network shows nothing. A
service worker caching the last snapshot would at least show a stale number with a clear
badge, which is better than a blank screen in a waiting room.

---

## 10. What breaks first at scale

**1. SSE connection count, per pod.** Node holding a few thousand open responses starts
spending real time in the event loop on heartbeats alone, and each connection carries an
Express `Response`. *The fix, in order:* raise `SSE_HEARTBEAT_SECONDS` toward the proxy
limit; then the Go fan-out service on the same Redis channels (§7).

**2. `tokens` table growth.** One row per patient per day forever. At 400-day retention and
fifty clinics at 150 tokens/day that is ~3M rows — comfortable. At five hundred clinics it is
30M, and the tenant-scoped reporting index starts to matter a lot. *The fix:* the
`TOKEN_RETENTION_DAYS` sweep (already configured, default 400) actually running on a
schedule, then partitioning `tokens` by `serviceDate` range with old partitions detached to
cold storage. `02-DATABASE.md` §9.

**3. The `queue_counters` lock, at a genuinely busy counter.** The lock serialises issuance
per queue per day. At a clinic door this is invisible. At a passport office issuing 3,000
tokens between 08:00 and 09:00 across one queue, transactions queue behind one row. *The fix,
in order:* shorten the transaction (move the `dailyCapacity` count to a cheaper form), then
split the queue — which is the real answer, because a single line of 3,000 people is a
product failure before it is a database one.

**4. `audit_events`, silently.** Append-only, no retention, grows with every action —
several rows per token. Nobody notices until a query plan flips. *The fix:* a retention
window, and moving the dispute-resolution lookup to `(tenantId, subjectId)` only, which the
index already serves.

---

## 11. What I would keep, and what I would change

**Keep without hesitation:**

- **The row lock for numbering.** It is the decision the product's credibility rests on and
  it is structural — it works because of where it sits, not because anyone remembered to be
  careful.
- **Idempotency in the same transaction as the action.** The atomicity is the feature.
- **SSE over WebSockets.** Matched to the traffic shape, the hardware and the network.
- **One `snapshot()` for all three surfaces.** They cannot drift.
- **Failing open in Redis, failing closed in Postgres.** Each layer fails in the direction
  that matches what it protects.

**Change:**

- **Move the retention and idempotency sweeps into a real scheduler** with observability.
  They are configured (`TOKEN_RETENTION_DAYS`, the 24h idempotency TTL) and the sweep methods
  exist; a cron that nobody watches is a cron that silently stopped in March.
- **Add the Go fan-out earlier than the trigger suggests.** Not because it is needed, but
  because the channel contract is cheap to honour today and gets more expensive to extract
  the longer the SSE endpoints and the service layer share a module graph. The discipline
  that keeps it cheap — event payloads that are self-contained snapshots, channel names as a
  documented scheme — is in place, but discipline decays and a process boundary does not.
- **Denormalise a `queueId`-free tenant reporting path.** Reports currently range-scan
  `(tenantId, serviceDate)` and aggregate in the application. A daily rollup table written at
  the service-date boundary would make the dashboard O(days) instead of O(tokens).

---

## 12. Related documents

- `02-DATABASE.md` — every table and column, the state-machine transition table, the
  `queue_counters` lock in full depth with an interleaving timeline, every index and the
  query it serves, the daily reset, retention, and the SQL you will actually run.
