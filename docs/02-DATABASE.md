# 02 — Database

PostgreSQL 16 accessed through Prisma — except for the row locks, which Prisma cannot
express and which are therefore hand-written `$queryRaw`.

This document covers every table and every column and why it is shaped that way; the token
state machine as a transition table including which transitions are illegal and what each
illegal one would corrupt; the `queue_counters` lock in full depth with an interleaving
timeline; every index and the query it serves; the daily reset and why it is a tenant-local
`date`; retention; tenant isolation; and the SQL you will actually run.

---

## 1. Two rules that run through the whole schema

Stated at the top of `schema.prisma`, because everything else follows from them:

> **1. Every tenant-owned row carries `tenantId`, and every index that serves a query starts
> with `tenantId`.** Not "the service layer remembers to" — the column exists so the filter
> is expressible in SQL, and the composite indexes are ordered `(tenantId, …)` so the
> filtered query is also the *fast* query. **A tenant filter that makes queries slower is a
> filter people delete.**
>
> **2. Postgres is the only system of record.** Token numbers are allocated under a row lock
> here. Idempotency records are written in the same transaction as the action they guard.
> The capacity cap is a `COUNT` inside that transaction. Redis is disposable.

Rule 1 is a security property; §8 covers how it is enforced. Rule 2 is the correctness
property the whole product rests on; §4 is the full argument.

---

## 2. ER diagram

```
 ┌────────────────────────────────────────┐
 │                tenants                 │  the root — everything cascades from here
 │────────────────────────────────────────│
 │ id            text  PK  (uuid)         │
 │ slug          varchar(60)  UNIQUE      │ ← /d/sunrise-dispensary
 │ name          varchar(120)             │
 │ logoUrl       varchar(500)?            │
 │ primaryColor  varchar(9)   '#0f766e'   │
 │ languages     text[]  ['si','ta','en'] │ ← display rotates through these
 │ ticketFooter  varchar(300)?            │
 │ timezone      varchar(60) 'Asia/Colombo'│ ← THE serviceDate boundary. §6
 │ plan          enum Plan    FREE        │
 │ features      jsonb        '{}'        │
 │ createdAt/updatedAt  timestamp         │
 └─┬──────┬──────┬──────┬──────┬──────────┘
   │1     │1     │1     │1     │1
   │N     │N     │N     │N     │N
   │      │      │      │      └────────────────────────┐
   │      │      │      └──────────────┐                │
   │      │      │                     │                │
   │  ┌───▼─────────────────────┐      │                │
   │  │         queues          │      │                │
   │  │─────────────────────────│      │                │
   │  │ id        text PK       │      │                │
   │  │ tenantId  text FK       │      │                │
   │  │ name      varchar(80)   │      │                │
   │  │ prefix    varchar(4)    │ ← A, B, PH            │
   │  │ status    enum QueueStatus                      │
   │  │ position  int           │      │                │
   │  │ avgServiceSeconds int 480      │                │
   │  │ dailyCapacity     int? │       │                │
   │  │ isArchived  bool false │       │                │
   │  │ createdAt/updatedAt    │       │                │
   │  │  U(tenantId, prefix)   │       │                │
   │  └───┬──────────────┬─────┘       │                │
   │      │1             │1            │                │
   │      │N             │N            │                │
   │  ┌───▼──────────────────────┐ ┌───▼────────────────────────────┐
   │  │      queue_counters      │ │      idempotency_keys          │
   │  │  ★ THE ALLOCATION ROW    │ │────────────────────────────────│
   │  │──────────────────────────│ │ id           text PK           │
   │  │ id          text PK      │ │ tenantId     text FK           │
   │  │ tenantId    text FK      │ │ key          varchar(80)       │
   │  │ queueId     text FK      │ │ endpoint     varchar(120)      │
   │  │ serviceDate date         │ │ requestHash  varchar(64)       │
   │  │ lastNumber  int  0       │ │ responseBody jsonb             │
   │  │ createdAt/updatedAt      │ │ createdAt    timestamp         │
   │  │  U(queueId, serviceDate) │ │ expiresAt    timestamp         │
   │  └──────────────────────────┘ │  U(tenantId, key)              │
   │      │                        └────────────────────────────────┘
   │      │N (queue)
   │  ┌───▼───────────────────────────────────────┐
   │  │                 tokens                    │
   │  │───────────────────────────────────────────│
   │  │ id           text PK  (uuid)              │
   │  │ tenantId     text FK                      │
   │  │ queueId      text FK                      │
   │  │ number       int                          │ ← 1..N per queue per day
   │  │ serviceDate  date                         │
   │  │ status       enum TokenStatus  WAITING    │ ← §3 state machine
   │  │ source       enum TokenSource  SELF       │
   │  │ publicId     varchar(32) UNIQUE           │ ← the patient's ONLY credential
   │  │ patientName  varchar(80)?                 │
   │  │ phoneHash    varchar(64)?                 │ ← never the plaintext number
   │  │ phoneLast4   varchar(4)?                  │
   │  │ deviceHash   varchar(64)?                 │
   │  │ issuedAt     timestamp                    │ ┐
   │  │ calledAt     timestamp?                   │ │ each is the ONLY
   │  │ servedAt     timestamp?                   │ │ source for one
   │  │ completedAt  timestamp?                   │ ┘ reported metric
   │  │ recallCount  int  0                       │
   │  │ lastActorId  varchar(36)?                 │
   │  │ note         varchar(200)?                │
   │  │ createdAt/updatedAt                       │
   │  │  ★ U(queueId, serviceDate, number)        │ ← THE BACKSTOP
   │  └───────────────────────────────────────────┘
   │
   │  ┌────────────────────────────┐    ┌────────────────────────────┐
   │  │           users            │    │      refresh_tokens        │
   │  │────────────────────────────│    │────────────────────────────│
   ├─►│ id           text PK       │    │ id         text PK         │
   │  │ tenantId     text FK       │    │ userId     text FK ────────┼─┐
   │  │ email        varchar(160)  │    │ tokenHash  varchar(64) U   │ │
   │  │ passwordHash varchar(72)   │    │ expiresAt  timestamp       │ │
   │  │ name         varchar(80)   │    │ revokedAt  timestamp?      │ │
   │  │ role         enum Role     │    │ createdAt  timestamp       │ │
   │  │ isActive     bool true     │◄───┴────────────────────────────┘ │
   │  │ createdAt/updatedAt        │                                   │
   │  │  U(tenantId, email)        │◄──────────────────────────────────┘
   │  └──────────┬─────────────────┘
   │             │1
   │             │N  (SetNull, not Cascade)
   │  ┌──────────▼─────────────────┐
   └─►│        audit_events        │
      │────────────────────────────│
      │ id         text PK         │
      │ tenantId   text FK         │
      │ userId     text FK?        │ ← null for self-service
      │ action     varchar(60)     │ ← 'token.called'
      │ subjectId  varchar(36)?    │ ← NOT a foreign key, on purpose
      │ meta       jsonb  '{}'     │
      │ createdAt  timestamp       │
      └────────────────────────────┘

  U = UNIQUE   ★ = the two constraints the product's credibility rests on
  Every FK to tenants is ON DELETE CASCADE.
  audit_events.userId is ON DELETE SET NULL — the record outlives the actor.
```

---

## 3. Tables, column by column

### `tenants`

One clinic / salon / branch office. The root of every ownership chain.

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | UUID, not an autoincrement. IDs appear in API responses; sequential integers leak business volume and make enumeration trivial |
| `slug` | `varchar(60)` UNIQUE | Public URL segment: `/d/sunrise-dispensary`, `/q/sunrise-dispensary/A`. Unique **globally** because it appears in a URL with no other qualifier. Deliberately not a secret — it is printed on a QR poster on a wall |
| `name` | `varchar(120)` | Shown on the display header and on the ticket |
| `logoUrl` | `varchar(500)?` | Branding. Nullable — a clinic without a logo is normal, not an error |
| `primaryColor` | `varchar(9)` default `#0f766e` | Display accent. A default means a tenant's display looks finished the moment they sign up, before anyone opens the settings page. 9 chars fits `#RRGGBBAA` |
| `languages` | `text[]` default `['si','ta','en']` | Languages offered on **public** surfaces, in display order. The display rotates through these; the phone page defaults to the first and offers a switcher. A Postgres array rather than a join table because there are three possible values, they are read on every display frame, and nothing ever queries *by* language |
| `ticketFooter` | `varchar(300)?` | Free text at the bottom of a thermal ticket — "Keep this slip", a phone number, a clinic motto. Per-tenant, so it is data and not code |
| `timezone` | `varchar(60)` default `Asia/Colombo` | **Not cosmetic.** `serviceDate` — the daily reset boundary — is computed in this zone. §6 is entirely about this column |
| `plan` | `enum Plan` default `FREE` | Billing scaffolding. No billing exists in v1; the column exists so adding it later is a data change, not a migration that touches every row |
| `features` | `jsonb` default `{}` | Per-tenant overrides, e.g. `{"sms": false, "maxQueues": 5}`. JSON so a new flag needs no migration; reads are rare (settings pages, a cached check), so the lack of indexability costs nothing. A one-off "this clinic also gets SMS" needs no schema change at all |
| `createdAt`, `updatedAt` | `timestamp` | Prisma's `@updatedAt` maintains the second |

### `users`

Staff accounts — the people who log in to the console. **Not** patients; patients never sign
in and are tracked only as an anonymous hashed device.

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | As above |
| `tenantId` | `text` FK | Which clinic this account belongs to |
| `email` | `varchar(160)` | Unique **per tenant**, not globally — see below |
| `passwordHash` | `varchar(72)` | bcrypt output is exactly 60 chars; 72 is bcrypt's own input byte limit and a comfortable column width. Named `_hash` so nobody ever writes a plaintext password into it by accident |
| `name` | `varchar(80)` | Display name on the console and in the audit trail |
| `role` | `enum Role` | `OWNER \| STAFF`. Deliberately only two — a dispensary has an owner and counter staff, and inventing ADMIN/SUPERVISOR tiers nobody asked for means writing a permission matrix that is never exercised. Ranked, not set-based: `RolesGuard` compares rank, so `OWNER > STAFF` |
| `isActive` | `bool` default `true` | **Soft disable.** Deleting a staff row would orphan the audit trail of every token they called; deactivating keeps history intact while killing access on the next request, because `JwtStrategy` re-reads the user row every time rather than trusting the claim |
| `createdAt`, `updatedAt` | `timestamp` | |

**`@@unique([tenantId, email])`, not `@@unique([email])`.** The same nurse can legitimately
work at two clinics on two days of the week. Forcing a second email address on her is a
product bug dressed as a constraint. Login resolves the tenant by slug when the address is
ambiguous.

### `refresh_tokens`

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `userId` | `text` FK | Cascades from `users` |
| `tokenHash` | `varchar(64)` UNIQUE | **SHA-256 hex of the token; the raw token is never stored.** A database dump therefore does not hand an attacker live sessions. SHA-256 and not bcrypt because the token is already 256+ bits of CSPRNG entropy — there is nothing to brute force — and this is looked up on *every* refresh, where bcrypt's deliberate cost would be a per-request tax for zero security gain. **Hashing a high-entropy secret is a different problem from hashing a human-chosen password**, and reaching for the password tool is a common and expensive mistake |
| `expiresAt` | `timestamp` | Absolute expiry, independent of the JWT's own claim |
| `revokedAt` | `timestamp?` | Set on rotation. **Presenting an already-revoked token means it was replayed**, which triggers family-wide revocation — standard refresh-token-rotation theft detection. Null means live |
| `createdAt` | `timestamp` | |

### `queues`

One line. Usually one doctor or one counter.

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `tenantId` | `text` FK | |
| `name` | `varchar(80)` | Human name on the display: "Dr. Perera", "Pharmacy" |
| `prefix` | `varchar(4)` | The letter(s) before the number: `A-001`, `PH-001`. Normalised to uppercase letters only — mixed case would make "a" and "A" two queues whose printed slips are indistinguishable, and a digit would make "A1-014" ambiguous to parse |
| `status` | `enum QueueStatus` | `OPEN \| PAUSED \| CLOSED`. **`PAUSED` is the state that actually gets used**: not issuing new tokens (doctor on tea break) but the already-issued ones remain valid and the display keeps showing the current number. `CLOSED` is end of day |
| `position` | `int` default `0` | Ordering on the display and the console tabs. Not the id, so the owner can reorder without recreating queues — and recreating a queue would orphan its history |
| `avgServiceSeconds` | `int` default `480` | Seed for the ETA before there is same-day data to average. 8 minutes is a general-practice consultation; per queue because a pharmacy counter is 2 minutes and a dentist is 25 |
| `dailyCapacity` | `int?` | Hard cap on tokens per service day, or null for unlimited. A real clinical need ("Dr. Perera sees 40 patients, after that go home") **and** the cheapest defence against a bot minting 500 tokens overnight |
| `isArchived` | `bool` default `false` | **Soft delete.** A hard delete cascades away every token ever issued in this queue — the data the monthly reports are built from. An owner removing a doctor who left in March should not erase March's numbers |
| `createdAt`, `updatedAt` | `timestamp` | |

**`@@unique([tenantId, prefix])`.** Two queues cannot both mint "A-007". On a paper slip
those are indistinguishable; on a display it is a support call. The service returns a 409
with exactly that explanation rather than a raw constraint error.

**Changing a prefix mid-day is blocked** while any token is still active, because tokens
render their label from the queue's *current* prefix — so the change is retroactive, and the
display would announce "B-014" for a patient holding a slip that says "A-014".

### `queue_counters`

**THE allocation row.** One per `(queue, service day)`. §4 is the full argument; the columns:

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | Generated by `gen_random_uuid()` in the raw upsert, or by Prisma elsewhere |
| `tenantId` | `text` FK | Present even though `(queueId, serviceDate)` is already unique. It costs nothing and it means this query, read in isolation during a code review, is **visibly tenant-scoped like every other query in the system**. Uniformity is what stops the rule eroding |
| `queueId` | `text` FK | |
| `serviceDate` | `date` (`@db.Date`) | The LOCAL service day in the tenant's timezone. Deliberately a plain date and not a timestamp: the daily reset is a calendar concept, and comparing dates has no boundary arithmetic to get wrong. §6 |
| `lastNumber` | `int` default `0` | Highest number issued so far today. The next token is this + 1 |
| `createdAt`, `updatedAt` | `timestamp` | `updatedAt` is set explicitly in the raw upsert (`"updatedAt" = NOW()`) because raw SQL bypasses Prisma's `@updatedAt` |

**`@@unique([queueId, serviceDate])`** does two jobs. It enforces one counter row per queue
per day, and it is what makes the "create it if today's row does not exist yet" step safe:
it is the conflict target of the upsert, so two concurrent first issuers resolve to one
`INSERT` and one `UPDATE`. §4.

### `tokens`

The row a patient is holding a slip for.

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | Internal. Never shown to a patient |
| `tenantId` | `text` FK | Denormalised from `queues` deliberately. Every token query filters by tenant, and going through `queues` would mean a join before the index could be pruned. **Denormalisation for isolation, which is the one kind always worth taking** |
| `queueId` | `text` FK | |
| `number` | `int` | The sequence number within `(queue, serviceDate)`. Displayed as `${prefix}-${number padded to 3}` — `A-014`. Padded because fixed width is what a person reads at a glance from ten metres across a waiting room; a number that jumps left and right as it counts up is genuinely harder to track. Beyond 999 the pad is exceeded rather than truncated, so a government counter issuing 1,200 tokens still works |
| `serviceDate` | `date` | Part of both the unique constraint and every index. §6 |
| `status` | `enum TokenStatus` | `WAITING \| CALLED \| SERVING \| DONE \| NO_SHOW \| CANCELLED`. §5 |
| `source` | `enum TokenSource` | `SELF \| COUNTER`. Kept because it is the single most useful number when selling the product: **"62% of your patients took their own token this week"** is the sentence that justifies the monthly fee |
| `publicId` | `varchar(32)` UNIQUE | **The patient's only credential.** 16 bytes of CSPRNG, base64url — 128 bits. `/t/<publicId>` is what their phone bookmarks and what authorises cancelling their own token, so it must not be enumerable. `/t/A-014` would let anyone cancel a stranger's place or watch the whole clinic's traffic |
| `patientName` | `varchar(80)?` | For the display's "Now serving A-014 — Nimal" courtesy line. **Optional** because a queue that demands identity at the door stops being faster than the paper slip it replaces |
| `phoneHash` | `varchar(64)?` | SHA-256. **The plaintext number is never stored.** v1 sends no SMS so the plaintext has no use, and a database of patient phone numbers at a medical clinic is the single worst thing in this system to leak. The hash supports "is this the same person as yesterday" analytics and a future opt-in lookup |
| `phoneLast4` | `varchar(4)?` | So staff can read "…4821" back to a patient at the counter. Four digits is a confirmation, not an identifier |
| `deviceHash` | `varchar(64)?` | HMAC-SHA256 of the device cookie id, **keyed with the same server secret** — so a leaked database alone does not let anyone correlate rows back to a cookie value they hold; the join requires the secret too. Enforces one-active-token-per-device without storing anything that identifies a person |
| `issuedAt` | `timestamp` default `now()` | Start of the WAIT measurement |
| `calledAt` | `timestamp?` | End of the wait: `waitSeconds = calledAt − issuedAt`. Overwritten by RECALL, on purpose — §5 |
| `servedAt` | `timestamp?` | Start of the SERVICE measurement |
| `completedAt` | `timestamp?` | End of it: `serviceSeconds = completedAt − servedAt`. **This is the number the ETA is built from**, which is why §5 cares so much about re-stamping it |
| `recallCount` | `int` default `0` | How many times CALLED was re-entered. "Three recalls then no-show" is the house rule most clinics land on, and it is visible on the console so staff do not have to remember |
| `lastActorId` | `varchar(36)?` | Which staff member last acted. Null for self-service issuance. **Not an FK** — deliberately loose, because it is a breadcrumb and `audit_events` is the real record |
| `note` | `varchar(200)?` | Free note staff attach: "wheelchair", "came with baby" |
| `createdAt`, `updatedAt` | `timestamp` | |

**Why four timestamp columns and not an events table.** Each column is the only source for
one reported metric. An events table is the phase-2 upgrade when per-transition audit
matters; today `audit_events` records every transition with `from`/`to` in its `meta`, so
the audit need is already met — what an events table would add is efficient *queryability*
of that history, at the cost of turning every current-state read into an aggregate.
`01-ARCHITECTURE.md` §7 argues it properly.

### `idempotency_keys`

Replay protection for every state-changing action.

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `tenantId` | `text` FK | Keyed by `(tenantId, key)` so one tenant's client cannot collide with — or probe for — another's keys |
| `key` | `varchar(80)` | Client-generated, e.g. a UUID per button press |
| `endpoint` | `varchar(120)` | Route + method. The same key reused for a **different** action is a client bug we can detect (409) rather than silently returning the wrong body |
| `requestHash` | `varchar(64)` | SHA-256 of an **order-stable** serialisation of the body. Keys are sorted before hashing so `{a:1,b:2}` and `{b:2,a:1}` hash identically — otherwise a client whose JSON serialiser reorders keys between attempts gets a spurious 409 on a retry that is genuinely the same request |
| `responseBody` | `jsonb` | The stored success response, replayed verbatim |
| `createdAt` | `timestamp` | |
| `expiresAt` | `timestamp` | 24h TTL. Much longer than any plausible retry — a tablet offline for a day should be issuing a *new* command, not replaying a stale one — and short enough that the table stays small |

**An expired-but-not-yet-swept row is still honoured as a valid replay.** The sweep is a
storage optimisation, not a correctness boundary, and honouring a stale row is strictly
safer than re-running the action.

### `audit_events`

Append-only record of actions on tokens and queues.

| Column | Type | Why it exists |
|---|---|---|
| `id` | `text` PK (uuid) | |
| `tenantId` | `text` FK | |
| `userId` | `text` FK? | **`ON DELETE SET NULL`, not Cascade.** The record must outlive the actor. Null also means "self-service action taken by a patient", which is a legitimate and common case |
| `action` | `varchar(60)` | `token.issued`, `token.called`, `token.no_show`, `queue.paused`. A string and not an enum, because the vocabulary grows whenever a feature is added and an audit log is the wrong place to need a migration |
| `subjectId` | `varchar(36)?` | The affected token or queue id. **Not a foreign key, on purpose:** audit rows must survive the deletion of what they describe, which a FK with cascade would prevent and a FK with restrict would make deletion impossible |
| `meta` | `jsonb` default `{}` | Previous status, idempotency key, IP, queue id, number. Whatever settles a dispute |
| `createdAt` | `timestamp` | |

**Why this table exists at all.** Small clinics have disputes — "I was here before her". A
timestamped record of who called what, and when, settles it in ten seconds. It is also the
honest answer to "what if a staff member cancels tokens maliciously": we cannot stop someone
with legitimate access, but we can make it visible.

---

## 4. The numbering invariant: the lock, the constraint, and the transaction

This is the centrepiece. The requirement, precisely:

> For a given `(queue, serviceDate)`, the numbers issued are exactly `1..N` — **no gaps and
> no duplicates** — no matter how many patients scan the QR at the same instant as staff
> press "Issue" at the counter.

Both halves matter and they fail differently. A **duplicate** means two people are holding
`A-014` and one of them is about to lose an argument. A **gap** means the display jumps from
14 to 16, and the clinic asks what happened to 15 — a question with no good answer.

### The three layers

| Layer | Mechanism | What it covers | What it cannot cover |
|---|---|---|---|
| **1** | The row lock taken by `INSERT … ON CONFLICT DO UPDATE` on the `queue_counters` row | Concurrency. Postgres serialises issuers on one row, in arrival order | A code path that does not take the lock |
| **2** | `UNIQUE (queue_id, service_date, number)` on `tokens` | A bug, a migration, or a manual `INSERT` during support that bypasses layer 1 | Nothing — it is absolute. It converts a disaster into a 409 |
| **3** | The same transaction enforces `dailyCapacity` and inserts the token | A rejected token consuming a number and leaving a gap | Nothing in-scope |

### Layer 1, the actual SQL

```sql
INSERT INTO queue_counters (id, "tenantId", "queueId", service_date, last_number, "updatedAt")
VALUES (gen_random_uuid()::text, $1, $2, $3::date, 1, NOW())
ON CONFLICT ("queueId", service_date)
DO UPDATE SET last_number = queue_counters.last_number + 1, "updatedAt" = NOW()
 WHERE queue_counters."tenantId" = EXCLUDED."tenantId"
RETURNING last_number;
```

Raw SQL because **Prisma has no first-class row-lock or upsert-increment API** that
expresses this in one statement. It is parameterised through Prisma's tagged template, so
values are bound rather than interpolated. The date is bound as `YYYY-MM-DD` and cast, so
the session timezone cannot shift it.

The `DO UPDATE` path takes a row-level exclusive lock on the counter row, held until
commit. It must be inside a transaction: outside one it is released
immediately, which would make the function *look* correct while providing no protection at
all. That is precisely the kind of bug that passes every test which does not run requests in
parallel, which is why the integration suite fires thirty simultaneously.

Until 2026-10-31 this was a `SELECT … FOR UPDATE` followed by an `UPDATE`, and issuing also
locked the `queues` row first. The k6 morning rush showed patients queueing behind
counters on that queue row, so issuing now takes **only** the counter-row lock, and takes it
first. [ADR 0007](adr/0007-issue-on-the-counter-row-only.md) has the measurements and the
trade-off.

### The interleaving, drawn out

Two patients scan the QR at the same millisecond. Counter row currently says
`last_number = 13`.

```
  Transaction A  (phone 1)                  Transaction B  (phone 2)
  ─────────────────────────────────────     ─────────────────────────────────────
  t0  BEGIN
  t1  read queue (no lock): OPEN
  t2                                        BEGIN
  t3                                        read queue (no lock): OPEN
  t4  INSERT … ON CONFLICT DO UPDATE
         → 14   ← holds the counter row
  t5                                        INSERT … ON CONFLICT DO UPDATE
                                            ░░ BLOCKED on the counter row ░░
  t6  device check: no active token
  t7  capacity: 13 < 40  ✓
  t8  INSERT INTO tokens (number = 14)
  t9  INSERT INTO audit_events
  t10 INSERT INTO idempotency_keys
  t11 COMMIT  ── lock released ──►
  t12                                       ░░ UNBLOCKED ░░ → 15
  t13                                       device check, capacity: 14 < 40  ✓
  t14                                       INSERT INTO tokens (number = 15)
  t15                                       COMMIT

  Result: A-014 and A-015. No duplicate. No gap. B waited a few ms.
```

The thing to notice at **t12**: B gets 15, not 14, even though B's transaction began at t2,
*before* A committed. Under READ COMMITTED, an `UPDATE` that waited for a row lock re-reads
the row after the lock is granted, so it increments the latest committed version.

The device and capacity checks run **after** the number is claimed, so they run one issuer
at a time, exactly as they did when the queue row was locked. If a check rejects the
patient, the rollback returns the number: the next issuer gets 15 again, and there is no
gap.

"Call next" and the other counter actions still lock the `queues` row, with
`FOR NO KEY UPDATE` (`src/tokens/queue-lock.ts`). Issuing never
touches that lock, so a patient scanning the QR no longer waits for a counter's "Done", and
the reverse.

### The first token of the day

There is no counter row before the first token of the day, and a `SELECT … FOR UPDATE`
cannot lock a row that does not exist. The upsert covers this case in the same statement:

```
  Transaction A                             Transaction B
  ─────────────────────────────────────     ─────────────────────────────────────
  t1  INSERT … ON CONFLICT  → inserts 1
  t2                                        INSERT … ON CONFLICT
                                            ░░ BLOCKED on the unique index ░░
  t3  INSERT tokens (number = 1)
  t4  COMMIT ──────────────────────────────►
  t5                                        conflict → DO UPDATE → 2
  t6                                        INSERT tokens (number = 2) → COMMIT

  Result: 1 and 2, with no retry in application code.
```

The previous version caught the unique violation (`P2002`) and re-read. The upsert removes
that branch, so the allocation path has no retry at all.

### Why not Redis `INCR`

The obvious "faster" answer. Three independent reasons, each disqualifying on its own:

| # | Problem | Consequence a customer sees |
|---|---|---|
| 1 | **Redis is not durable enough to be a counter of record.** A restart with default RDB snapshotting loses the last seconds of increments, so the counter goes **backwards**. AOF `everysec` still loses up to a second. AOF `always` is slower than the Postgres row lock it was meant to replace | Two patients holding `A-014` |
| 2 | **`INCR` and `INSERT` are two systems.** A crash between them burns a number | The display jumps 14 → 16 and the clinic asks what happened to 15 |
| 3 | **Rollback is impossible.** If the `INSERT` then violates `dailyCapacity`, the number is already spent. `DECR` is not a safe undo — another issuer may have incremented in between | A gap, again, and this one is reachable by ordinary use rather than by a crash |

The lock costs a few milliseconds on a row contended by at most a handful of people standing
at a door. That is the correct trade for an invariant a customer can verify with their own
eyes on a paper slip.

### Why not `SELECT MAX(number) + 1`

Because Postgres's default isolation level is **READ COMMITTED**, and under READ COMMITTED a
plain `SELECT` takes no lock at all:

```
  Transaction A                             Transaction B
  ─────────────────────────────────────     ─────────────────────────────────────
  t1  SELECT MAX(number) FROM tokens
        WHERE queue_id=$1 AND service_date=$2
        → 13                                   (no lock taken)
  t2                                        SELECT MAX(number) … → 13
  t3  next = 14                             next = 14
  t4  INSERT tokens (number = 14)
  t5                                        INSERT tokens (number = 14)
                                            ░░ BLOCKED on the unique index ░░
  t6  COMMIT ──────────────────────────────►
  t7                                        ░░ 23505 unique violation ░░

  Result: a patient who did nothing wrong gets an error and has to scan again.
```

The unique index saves correctness — layer 2 doing its job — but the *user experience* is
now an error on a normal action. **The lock turns a failure into a wait, and a
two-millisecond wait is invisible.** That is the entire difference between the two designs.

There is a second, quieter problem: `MAX()` over `tokens` scans an index that grows all day,
whereas the counter is a single-row lookup that is the same cost at token 1 and token 400.

### Why not `SERIALIZABLE` isolation

It would also be correct. `SERIALIZABLE` in Postgres uses Serializable Snapshot Isolation and
would detect the `MAX()` anomaly above as a read-write conflict, aborting one transaction
with `40001`.

Three reasons not to:

1. **It converts contention into serialisation failures the application must retry.** Every
   `40001` is now the app's problem: a retry loop, a backoff, a cap, and a decision about
   what to tell the patient when the cap is hit. That is more code than one locking
   upsert, and it is code that only executes under load — which is to say, code that is hard to
   test and easy to get wrong.
2. **It applies that cost to every statement in the transaction**, including the capacity
   `COUNT` and the audit insert, which have no concurrency requirement at all. The row lock is
   narrower: it protects exactly the one row that needs protecting.
3. **It does not state the intent.** An explicit row lock on the counter row says "this row is the
   allocation point" to anyone reading the file. A transaction isolation setting configured
   somewhere else says nothing at the point of use.

### Layer 2, and why a constraint that never fires is not wasted

```sql
UNIQUE (queue_id, service_date, number)
```

If the counter logic is ever bypassed — a bug, a migration, a support engineer running a
manual `INSERT` at 6 a.m. — the database refuses the duplicate. The failure mode becomes a
409 the staff member can read, instead of two patients standing at one counter holding
identical slips.

This is the general principle worth taking away: **the constraint that never fires is the
reason the worst case is recoverable.** Its value is not in how often it triggers.

---

## 5. The token state machine

The rulebook lives in exactly one file, `src/tokens/token-state.ts`, as **data rather than a
switch** — so the unit tests can walk every `(status, action)` pair and assert the legal set
is exactly this. A test that iterates the same table the implementation reads cannot drift
from it.

### The transition table

Rows are the current status; columns are the action. `✓` is legal; the cell shows the
resulting status and the timestamps stamped.

| from ↓ / action → | CALL | RECALL | START | DONE | SKIP | NO_SHOW | CANCEL |
|---|---|---|---|---|---|---|---|
| **WAITING** | ✓ `CALLED`<br>`calledAt=now` | ✗ | ✗ | ✗ *(via implicit START — see below)* | ✗ | ✗ | ✓ `CANCELLED`<br>`completedAt=now` |
| **CALLED** | ✗ | ✓ `CALLED`<br>`calledAt=now`<br>`recallCount+1` | ✓ `SERVING`<br>`servedAt=now` | ✗ → **implicit START first**, then `DONE` | ✓ `WAITING`<br>*(nothing stamped)* | ✓ `NO_SHOW`<br>`completedAt=now` | ✓ `CANCELLED`<br>`completedAt=now` |
| **SERVING** | ✗ | ✗ | ✗ | ✓ `DONE`<br>`completedAt=now` | ✗ | ✓ `NO_SHOW`<br>`completedAt=now` | ✗ |
| **DONE** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **NO_SHOW** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **CANCELLED** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

```
                 ┌──────────────────────────────────┐
                 │            issue                 │
                 ▼                                  │
            ┌─────────┐                             │
      ┌────►│ WAITING │──── CANCEL ────┐            │
      │     └────┬────┘                │            │
      │          │ CALL                │            │
      │          ▼                     ▼            │
      │     ┌─────────┐◄── RECALL ┌───────────┐     │
      │     │ CALLED  │────────┐  │ CANCELLED │     │
      │     └──┬───┬──┘        │  └───────────┘     │
      │ SKIP   │   │ CANCEL ───┘        (terminal)  │
      └────────┘   │                                │
                   │ START                          │
                   ▼                                │
              ┌─────────┐                           │
              │ SERVING │──── NO_SHOW ──┐           │
              └────┬────┘               │           │
                   │ DONE    CALLED ────┤           │
                   ▼         NO_SHOW    ▼           │
              ┌────────┐         ┌──────────┐       │
              │  DONE  │         │ NO_SHOW  │       │
              └────────┘         └──────────┘       │
               (terminal)         (terminal)        │
                                                    │
   DONE / NO_SHOW / CANCELLED are terminal. Terminal means terminal.
```

### Why each illegal transition is illegal

This is the part that matters. The legal transitions are obvious; the illegal ones are where
the reasoning lives, and they are exactly what scattered `if` statements forget.

| Illegal transition | What a naive implementation would do | Why it is actually harmful |
|---|---|---|
| **DONE → DONE** | Re-stamp `completedAt` | **The headline case.** `serviceSeconds = completedAt − servedAt` is one sample in the rolling median that *every waiting patient's ETA* is computed from. A double-tap on a tablet re-stamps `completedAt` minutes later, inflating one sample from 6 minutes to 11 — and since the median is over only 10 samples, that moves the advertised wait for everyone in the room. **A patient sees a wrong number on their phone because a button was double-tapped.** One table makes it impossible |
| **NO_SHOW → NO_SHOW** | Re-stamp `completedAt` | Same corruption of "how long was this token open", and it double-counts nothing but silently moves the retention sweep's idea of when the token closed |
| **CANCELLED → CANCEL** | Re-stamp `completedAt` | Same. Also: cancellation frees a `dailyCapacity` slot, and re-running the path invites a second free slot if the capacity logic is ever moved |
| **SERVING → CANCEL** | Mark a consultation that happened as cancelled | **Silently removes a real consultation from the day's report.** Once a doctor has started, the outcome is `DONE` or `NO_SHOW` — those are the only two things that actually happened. "Cancelled" would understate the doctor's workload and inflate the apparent capacity of the clinic |
| **SERVING → CALL / RECALL** | Re-stamp `calledAt` while a patient is in the room | Overstates the patient's wait (`calledAt − issuedAt`) and, worse, makes the display announce a number for someone who is already sitting with the doctor |
| **WAITING → START / DONE** | Stamp `servedAt`/`completedAt` for a patient who was never called | Records a consultation nobody was announced for. The display never showed the number, so nobody in the room can reconcile the report against what they saw |
| **WAITING → RECALL** | Stamp `calledAt` and bump `recallCount` | Announces a patient who has not been called once. `recallCount` is what drives "three recalls then no-show", so it would trigger a no-show for someone who was never called |
| **CALLED → CALL** | Re-stamp `calledAt` silently | This *is* a real action, and modelling it as `CALL` would lose the `recallCount`. It is therefore modelled as `RECALL` — a legal self-transition that bumps the counter |
| **any terminal → anything** | Reanimate a closed token | A token that has left the system is out of `peopleAhead`, out of the capacity count, out of the ETA sample window. Bringing it back changes every one of those retroactively |

### Two transitions that look wrong and are deliberate

**`CALLED → RECALL → CALLED` is a legal self-transition, and it overwrites `calledAt`.**

Announcing "A-014" a second time is a real and frequent action. Modelling it as a no-op
would lose `recallCount`, which is what tells staff when to give up. Overwriting `calledAt`
is deliberate too: *"how long ago were they called"* is what drives the staff nudge to mark
a no-show, and that clock should restart on each announcement. The consequence — a recalled
token reports a longer wait in the report — is **correct**: the patient genuinely waited
that long.

**`CALLED → SKIP → WAITING` does not clear `calledAt`.**

The patient really was called. Erasing the timestamp would understate their wait in the
report, and the report is what the owner uses to decide whether to add a second doctor.

### The implicit START

The machine requires `CALLED → SERVING → DONE`. Many clinics never press "Start" — the
doctor calls a patient and finishes with them — and a console that refuses "Done" because of
a step nobody performed is a console staff will fight.

Resolved by **inserting the missing transition** rather than by weakening the machine:

```typescript
let current = token;
if (action === TokenAction.DONE && token.status === TokenStatus.CALLED) {
  const startEffects = transitionEffects(token.status, TokenAction.START, now);
  current = await tx.token.update({
    where: { id: token.id },
    data: { status: startEffects.status, servedAt: startEffects.servedAt },
  });
}
```

The model stays truthful and `servedAt` gets a real value, so the service-time average — and
therefore every patient's ETA — is still computed from something meaningful. The cost is a
near-zero-length service sample, which `usableSamples` discards as implausible (below 20
seconds), so it cannot skew the estimate. **Allowing `CALLED → DONE` in the table instead
would have written a `NULL` `servedAt` and silently removed that token from the ETA sample
set forever.**

### How a transition is actually written

Even holding the queue lock, the write asserts its own precondition:

```typescript
const { count } = await tx.token.updateMany({
  where: { id: current.id, tenantId, status: current.status },
  data: { status: effects.status, /* … timestamps … */ },
});

if (count === 0) {
  throw new ConflictException(
    'This token changed while you were acting on it. Refresh and try again.',
  );
}
```

`updateMany`, not `update`, because only `updateMany` can express a non-unique predicate and
report the affected-row count. `update` matches on the primary key alone and would happily
overwrite a token another path had already moved — and would report success while doing it.

An `IllegalTransitionError` maps to **409, not 400**. The request is well-formed; it
conflicts with the token's current state. A tablet that double-tapped "Done" gets a reason it
can act on instead of a validation error it cannot.

---

## 6. The daily reset: `serviceDate`

Every queue restarts at 1 each morning. That boundary is the second most important decision
in the schema after the lock.

### Why it is the tenant's timezone and not UTC

The classic bug, with real numbers. Sri Lanka is UTC+5:30. A Colombo dispensary opens at
05:30 local time — which is **00:00 UTC**.

```
   Local (Asia/Colombo)      UTC              A naive UTC-midnight reset
   ─────────────────────     ─────────────    ────────────────────────────
   2026-09-14  05:30         09-14 00:00      ← ROLLS OVER HERE
   2026-09-14  06:00         09-14 00:30
   2026-09-14  07:45         09-14 02:15
   2026-09-14  08:00         09-14 02:30
```

A patient who arrived at 05:15 holding `A-041` would, at 05:30, watch the counter reset and
the display announce `A-001` — issued to someone who arrived twenty-five minutes *after*
them. The morning session would carry two overlapping number sequences for two and a half
hours, and the `UNIQUE(queueId, serviceDate, number)` constraint would not catch it, because
by UTC reckoning those genuinely are two different days.

So: `serviceDate` is computed in `tenant.timezone` and stored as the local calendar date.

### Why a `date` column and not a `timestamp`

**The reset is a calendar concept, not an instant.** "Today's tokens" is a property of the
day, not of a range of nanoseconds.

| | `date` | `timestamp` |
|---|---|---|
| "Today's tokens" | `WHERE service_date = '2026-09-14'` | `WHERE issued_at >= $start AND issued_at < $end` |
| Boundary bugs | None — equality on a calendar value | Every `>=`/`<` pair is a chance to get inclusivity wrong |
| The unique key | `(queue_id, service_date, number)` is exactly "the numbers issued that calendar day" | Cannot be expressed — you cannot make a timestamp range part of a unique constraint |
| Index size | 4 bytes | 8 bytes, in every one of the four indexes it appears in |
| DST | The date is whatever the local calendar says | A 23- or 25-hour day needs special handling |

The unique-constraint row is decisive on its own. **You cannot build the numbering invariant
on a timestamp.** The entire §4 design requires a discrete value that identifies a day.

### The implementation, and its two traps

```typescript
export const serviceDateString = (timezone: string, at: Date = new Date()): string =>
  formatterFor(timezone).format(at);

export const serviceDate = (timezone: string, at: Date = new Date()): Date => {
  const [year, month, day] = serviceDateString(timezone, at).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
};
```

**Trap 1 — the locale.** `en-CA` is used because its short date format *is* ISO 8601
(`2026-09-14`). No manual part assembly from `formatToParts`, no locale surprises.

**Trap 2 — constructing the Date.** `Date.UTC(...)`, not `new Date('2026-09-14T00:00:00')`.
The string form is parsed in **server-local** time, so on a server west of UTC it would
store the *previous* day. Building at UTC midnight means whatever the server's own timezone
is, the driver serialises the same calendar day into the `date` column.

`Intl.DateTimeFormat` rather than a date library: it is built into Node, is IANA-accurate
including DST (Sri Lanka has none today, but a tenant in another zone may), and the whole job
is one function. Formatters are cached per timezone because constructing one is not cheap and
this runs on every public request.

**An invalid IANA zone falls back to `Asia/Colombo`** rather than throwing. A clinic running
with a possibly-wrong boundary is strictly better than a queue that cannot issue tokens at
all; the tenant settings form validates the zone on the way in, so this is a backstop and not
the primary defence.

`parseServiceDate` re-validates on the way back in, and specifically catches `2026-02-30`,
which `Date.UTC` silently rolls forward to March 2nd:

```typescript
if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
  throw new Error(`Invalid service date: ${value}`);
}
```

A report filter that silently queried the wrong day would be a bug nobody could see.

### What this deliberately does not handle

**A clinic that runs past local midnight.** A 24-hour emergency counter would reset at
00:00 with patients still waiting — exactly the bug this section exists to prevent, just
moved to a different hour. The correct fix is a per-queue "business day starts at HH:mm"
offset, which is a real feature and is not built. Today's answer is that dispensaries,
salons and government counters all close before midnight.

**A tenant changing their timezone mid-day.** Existing rows keep the `serviceDate` they were
written with; new tokens may land on a different date and restart at 1. Rare enough to be
left as a documented sharp edge rather than guarded.

---

## 7. Every index, and the query it serves

| Index | Table | Serves | Why the column order is what it is |
|---|---|---|---|
| `tenants_slug_key` | `tenants` | `WHERE slug = $1` | Every public request resolves a tenant by slug. UNIQUE gives the lookup *and* enforces that two clinics cannot claim one URL |
| `users_tenantId_email_key` | `users` | `WHERE "tenantId" = $1 AND email = $2` | The business rule "one account per email per tenant", enforced by the database rather than by a check someone can forget |
| `users_tenantId_idx` | `users` | `WHERE "tenantId" = $1` | The staff list on the settings page |
| `refresh_tokens_tokenHash_key` | `refresh_tokens` | `WHERE "tokenHash" = $1` | Every refresh. UNIQUE because two rows with one hash would make revocation ambiguous |
| `refresh_tokens_userId_idx` | `refresh_tokens` | `WHERE "userId" = $1` | Family-wide revocation on replay detection, and "log out everywhere" |
| `refresh_tokens_expiresAt_idx` | `refresh_tokens` | `WHERE "expiresAt" < now()` | The cleanup sweep, without scanning a table that grows with every login |
| `queues_tenantId_prefix_key` | `queues` | `WHERE "tenantId" = $1 AND prefix = $2` | The uniqueness rule. Also serves "find the queue the patient's QR named" |
| `queues_tenantId_isArchived_position_idx` | `queues` | `WHERE "tenantId"=$1 AND "isArchived"=false ORDER BY position` | **Both the console and the display ask exactly this.** `tenantId` first because it is the equality predicate on every query; `isArchived` second because it is also equality and it shrinks the set; `position` last because it is the *sort* — putting it last means filter and order are one index scan with **no sort step** |
| `queue_counters_queueId_serviceDate_key` | `queue_counters` | `INSERT … ON CONFLICT ("queueId", service_date) DO UPDATE` | **The hottest single lookup in the system** — it runs inside the lock on every token issued. UNIQUE is the conflict target the upsert needs, and what makes the first-issuer race resolvable (§4) |
| `queue_counters_tenantId_serviceDate_idx` | `queue_counters` | `WHERE "tenantId"=$1 AND service_date=$2` | The owner dashboard's "how many did each queue issue today" |
| `tokens_queueId_serviceDate_number_key` | `tokens` | The backstop constraint | **Layer 2 of §4.** Also incidentally serves `ORDER BY number` within a queue-day |
| `tokens_queueId_serviceDate_status_number_idx` | `tokens` | `WHERE "queueId"=$1 AND service_date=$2 AND status='WAITING' ORDER BY number ASC LIMIT 1` | **The "call next" read**, the most latency-sensitive query in the product. Three equality columns first, then the sort column — so it is a range scan that stops after one row rather than a filter-then-sort over the whole day's tokens. Reordering this to put `number` before `status` would force reading every token of the day and discarding the non-waiting ones |
| `tokens_tenantId_serviceDate_idx` | `tokens` | `WHERE "tenantId"=$1 AND service_date BETWEEN $2 AND $3` | Tenant-scoped reporting: "every token this clinic had on these dates". `tenantId` leads because it is the equality predicate on every single query; `serviceDate` follows because reports are ranges over it |
| `tokens_deviceHash_queueId_serviceDate_idx` | `tokens` | `WHERE "deviceHash"=$1 AND "queueId"=$2 AND service_date=$3 AND status IN (…)` | The self-service duplicate check, inside the issuing transaction. **`deviceHash` leads here and `tenantId` does not appear** — the only index in the schema that breaks the rule, because the device hash is a 256-bit HMAC and is already more selective than anything else available. The query still carries `tenantId` in its `WHERE`; it just is not what makes it fast |
| `idempotency_keys_tenantId_key_key` | `idempotency_keys` | `WHERE "tenantId"=$1 AND key=$2` | The pre-check on every guarded action, and the unique index that resolves the two-arrivals race (§ architecture 6) |
| `idempotency_keys_expiresAt_idx` | `idempotency_keys` | `WHERE "expiresAt" < now()` | The 24h sweep |
| `audit_events_tenantId_createdAt_idx` | `audit_events` | `WHERE "tenantId"=$1 ORDER BY "createdAt" DESC` | The owner's activity feed. Filter + sort in one scan |
| `audit_events_tenantId_subjectId_idx` | `audit_events` | `WHERE "tenantId"=$1 AND "subjectId"=$2` | **Dispute resolution:** "show me everything that happened to token X". The ten-second answer to "I was here before her" |

**The pattern:** every index that serves a tenant-facing query leads with `tenantId`, and
every list index carries its sort column as the trailing member so filter and order are one
index scan rather than a scan plus a sort. The one exception is
`tokens_deviceHash_queueId_serviceDate_idx`, and it is a considered exception rather than an
oversight — the leading column is a 256-bit hash, which is as selective as a column gets.

---

## 8. Tenant isolation

### The rule

> **Every query against a tenant-owned table includes `tenantId` in its `WHERE` clause. No
> exceptions. Not for internal callers, not for background jobs, not for staff endpoints.**

Not "the service layer checks ownership". Not "the guard already verified the JWT". The
`tenantId` goes in the query, so the database **never returns a row the caller is not
entitled to** — which means a bug in the application layer cannot become a data leak, because
the data was never selected.

### The canonical bug

```typescript
// ❌ WRONG — leaks across tenants
async findOne(queueId: string) {
  return this.prisma.queue.findUnique({ where: { id: queueId } });
}

// ✅ RIGHT — from queues.service.ts
async findOne(tenantId: string, queueId: string): Promise<Queue> {
  const queue = await this.prisma.queue.findFirst({
    where: { id: queueId, tenantId },
  });

  if (!queue) {
    throw new NotFoundException('Queue not found');
  }

  return queue;
}
```

**Why the wrong one is attractive.** `findUnique` is the natural Prisma call for "get by
primary key". It is faster in principle, it is what every tutorial shows, and the auth guard
has *already run* — the caller is definitely a logged-in staff member of some clinic. It
feels safe.

**Why it is not.** The guard proved *who* the caller is. It proved nothing about *which
queue they asked for*. A valid token for clinic A plus any UUID returns clinic B's queue, in
full. No guard catches it because no guard knows what the id refers to. The only thing that
can catch it is the query itself.

A `findUnique` followed by `if (queue.tenantId !== tenantId) throw` is **one forgotten line
away** from the same leak. The `findFirst` version cannot be forgotten, because there is no
version of the query without it.

**And 404, not 403.** Returning "403 Forbidden" confirms the id exists and belongs to someone
else — a free enumeration oracle. "404 Not Found" tells an attacker nothing, which is exactly
what they should learn.

### The rule on writes

Writes are worse, because a write leak is destructive rather than merely disclosing:

```typescript
const { count } = await tx.token.updateMany({
  where: { id: next.id, tenantId, status: TokenStatus.WAITING },
  data: { status: effects.status, calledAt: effects.calledAt, lastActorId: actorId },
});
```

`updateMany` is used specifically because `update` requires a unique selector and would force
`where: { id }` alone. The token id came from a query this same transaction just ran and is
completely trustworthy — **and the rule is applied anyway.** "Trusted caller" is how the rule
erodes: once one call site is exempt, the next argues by precedent, and eventually an exempt
call site takes an id from a request body.

### Where isolation holds outside SQL

The realtime layer follows the same structural rule:

```typescript
static tenantChannel(tenantId: string): string  { return `qlk:t:${tenantId}`; }
static queueChannel(t: string, q: string): string { return `qlk:t:${t}:q:${q}`; }
static tokenChannel(t: string, p: string): string { return `qlk:t:${t}:tok:${p}`; }
```

Tenant id is the **first segment of every channel**, and there is no wildcard subscribe
anywhere in the codebase. A subscriber builds the channel name from its own verified tenant,
so a subscription cannot accidentally span tenants. Isolation holds in the realtime layer for
the same structural reason it holds in SQL: the wrong rows are never selected, and the wrong
channel is never named.

### The one place the rule is relaxed, and why it is safe

`findByPublicId` and `cancelByPatient` look up a token by `publicId` alone, with no
`tenantId`:

```typescript
const token = await this.prisma.token.findUnique({
  where: { publicId: params.publicId },
  include: { queue: true },
});
```

This is correct, because **the caller has no tenant.** A patient's phone has no JWT; the
`publicId` *is* the credential, and it is 128 bits of CSPRNG specifically so that it can
carry that weight. The tenant is then *derived* from the row, not asserted by the caller.

Cancellation additionally requires the device cookie to match:

```typescript
if (!token.deviceHash || token.deviceHash !== params.deviceHash) {
  throw new ForbiddenException(
    'This token was taken on a different device. Ask the counter staff to cancel it.',
  );
}
```

Requiring both is deliberate. The `publicId` alone would let anyone who glimpsed a screenshot
cancel someone's place; the device alone would not identify which token. Together they are a
reasonable proof for an action whose worst outcome is losing your own turn.

### What backs the rule up

| Mechanism | What it guarantees |
|---|---|
| `tenantId` as the **first parameter** of every service method | There is no version of the call without one |
| `tenantId` in every `WHERE` | The database never returns a foreign row |
| `ON DELETE CASCADE` on every tenant FK | Deleting a tenant leaves nothing behind |
| Global `JwtAuthGuard`, opt out with `@Public()` | Fail-closed: a new endpoint is protected by default |
| `tokens.tenantId` denormalised | Isolation on the hottest table needs no join |
| Tenant id as channel prefix, no wildcard subscribe | Realtime isolation is structural, not checked |
| 404 instead of 403 | No confirmation that a foreign id exists |

**Deliberately not used: Row-Level Security.** It would be strictly stronger. It requires a
per-request `SET LOCAL app.tenant_id`, which interacts badly with transaction-mode connection
pooling — a pooled connection carrying the previous request's setting is a serious failure
mode and the wrong direction to fail in — and Prisma has no first-class support for it. The
honest position: **the current approach depends on discipline and RLS would not.** It is the
security improvement I would make first if this took payment data or grew a team.

---

## 9. Retention and sweeps

### Tokens — `TOKEN_RETENTION_DAYS`

```
TOKEN_RETENTION_DAYS: Joi.number().min(7).max(3650).default(400),
```

`tokens` grows by one row per patient per day, forever, and nothing in the product ever
reads a token from two years ago. **400 days** is the default for a specific reason: it is
slightly more than a year, so a clinic can answer "how did last September compare to this
September" — the one genuinely useful long-range question an owner asks — and then the data
goes.

The sweep:

```sql
DELETE FROM tokens
 WHERE service_date < (CURRENT_DATE - $1::int);
```

`service_date` and not `created_at`, so the boundary is the same calendar concept the rest of
the system uses, and the delete is a clean range over an indexed column.

**The minimum is 7, not 0.** A misconfiguration that wiped today's tokens would delete a
running clinic's queue mid-session. Joi refuses it at boot rather than at 11 a.m.

**What is deliberately *not* swept:** `audit_events`. Disputes surface late — a patient
complains a week later, an owner audits a month later — and the audit trail is small per
event and is the product's answer to "prove it". §11 flags this as a growth risk that needs a
policy, not as a solved problem.

### Idempotency keys

```typescript
async sweep(): Promise<number> {
  const { count } = await this.prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  // …
}
```

24-hour TTL, served by `idempotency_keys_expiresAt_idx`. The table would otherwise accumulate
one row per state-changing action forever — several hundred a day per clinic — for records
whose useful life is measured in seconds.

Crucially, **an expired row that has not yet been swept is still honoured as a valid replay**
(`idempotency.service.ts` returns it before checking expiry). The sweep is a storage
optimisation, not a correctness boundary. Treating it as a boundary would mean a retry
arriving one second after the sweep re-executes "Call next" — reintroducing the exact bug the
table exists to prevent.

### Refresh tokens

`refresh_tokens_expiresAt_idx` serves `DELETE WHERE "expiresAt" < now()`. Without it the
table grows with every login forever, and the `tokenHash` lookup on every refresh slowly
degrades.

### Cascades

```
  DELETE FROM tenants WHERE id = $1
    ├─► users            ──► refresh_tokens
    │                    ──► audit_events.userId  (SET NULL, not cascade)
    ├─► queues           ──► queue_counters
    │                    ──► tokens
    ├─► tokens
    ├─► queue_counters
    ├─► idempotency_keys
    └─► audit_events
```

One statement and the clinic's entire footprint is gone. "Delete my data" is a request a
medical product will receive and it should be one transaction rather than a checklist.

**`audit_events.userId` is `SET NULL`** so deactivating or removing a staff member does not
erase the record of what they did — the row survives with a null actor. **`audit_events` is
not deleted when its subject is**, because `subjectId` is a plain `varchar` and not a foreign
key: the record must outlive what it describes. A real FK would have forced a choice between
blocking token deletion and cascading the history away, and both are worse.

---

## 10. Queries you will actually run

Real SQL, with the index each one uses.

### Now serving

```sql
-- The SERVING token if there is one, otherwise the most recently CALLED.
-- Uses tokens_queueId_serviceDate_status_number_idx.
SELECT t.id, t.number, t.status, t."patientName", t."calledAt", t."servedAt"
  FROM tokens t
 WHERE t."tenantId"   = $1
   AND t."queueId"    = $2
   AND t.service_date = $3
   AND t.status IN ('SERVING', 'CALLED')
 ORDER BY
   CASE t.status WHEN 'SERVING' THEN 0 ELSE 1 END,
   COALESCE(t."servedAt", t."calledAt") DESC
 LIMIT 1;
```

The `CASE` ordering is the product decision: once a patient is with the doctor the screen
keeps showing their number, so anyone walking in knows where the queue stands. Showing the
last `CALLED` instead would flip the big number back to blank the moment the patient sat
down.

### Up next

```sql
-- The display's "coming up" panel. Uses the same index as call-next.
SELECT t.id, t."publicId", t.number, t."patientName"
  FROM tokens t
 WHERE t."tenantId"   = $1
   AND t."queueId"    = $2
   AND t.service_date = $3
   AND t.status       = 'WAITING'
 ORDER BY t.number ASC
 LIMIT 3;
```

`ORDER BY number`, **not** `ORDER BY "issuedAt"`. The number is the promise printed on the
patient's slip. In practice they agree; if they ever disagreed — a backdated token, a clock
adjustment — the patient's expectation is what must win.

### Call next (the read half)

```sql
SELECT t.*
  FROM tokens t
 WHERE t."tenantId"   = $1
   AND t."queueId"    = $2
   AND t.service_date = $3
   AND t.status       = 'WAITING'
 ORDER BY t.number ASC
 LIMIT 1
 -- preceded in the same transaction by:
 --   SELECT id FROM queues WHERE id = $2 AND "tenantId" = $1 FOR NO KEY UPDATE;
```

### Today's stats, one queue

```sql
SELECT
  COUNT(*)                                              AS issued,
  COUNT(*) FILTER (WHERE status = 'WAITING')            AS waiting,
  COUNT(*) FILTER (WHERE status = 'DONE')               AS served,
  COUNT(*) FILTER (WHERE status = 'NO_SHOW')            AS no_shows,
  COUNT(*) FILTER (WHERE status = 'CANCELLED')          AS cancelled,
  COUNT(*) FILTER (WHERE source = 'SELF')               AS self_service,
  ROUND(AVG(EXTRACT(EPOCH FROM ("calledAt" - "issuedAt")))
        FILTER (WHERE "calledAt" IS NOT NULL))          AS avg_wait_seconds,
  ROUND(AVG(EXTRACT(EPOCH FROM ("completedAt" - "servedAt")))
        FILTER (WHERE status = 'DONE' AND "servedAt" IS NOT NULL))
                                                        AS avg_service_seconds
  FROM tokens
 WHERE "tenantId"   = $1
   AND "queueId"    = $2
   AND service_date = $3;
```

`FILTER` rather than several `CASE WHEN … END` sums, and rather than several round trips: one
index scan over one queue-day produces every number on the owner's card. Uses
`tokens_tenantId_serviceDate_idx`.

`avg_wait_seconds` is computed over tokens that were actually called. Including uncalled ones
as zero would flatter the number; excluding them entirely is the honest reading of "how long
did people who got seen wait".

### No-show rate

```sql
SELECT
  service_date,
  COUNT(*) FILTER (WHERE status = 'NO_SHOW')                    AS no_shows,
  COUNT(*) FILTER (WHERE status IN ('DONE', 'NO_SHOW'))         AS resolved,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE status = 'NO_SHOW')
          / NULLIF(COUNT(*) FILTER (WHERE status IN ('DONE','NO_SHOW')), 0)
  , 1)                                                          AS no_show_pct
  FROM tokens
 WHERE "tenantId"   = $1
   AND "queueId"    = $2
   AND service_date BETWEEN $3 AND $4
 GROUP BY service_date
 ORDER BY service_date;
```

**The denominator is `DONE + NO_SHOW`, not `COUNT(*)`.** A `CANCELLED` token is a patient who
told us they were leaving — that is the system working, not a no-show — and a `WAITING` token
has not resolved yet. Counting either in the denominator would understate the rate and make
the metric useless for its actual purpose, which is deciding whether the clinic should
over-book.

`NULLIF(..., 0)` guards a day with no resolved tokens, which is a division by zero on any
public holiday.

### The rolling service average (what the ETA reads)

```sql
SELECT ROUND(EXTRACT(EPOCH FROM ("completedAt" - "servedAt")))::int AS service_seconds
  FROM tokens
 WHERE "tenantId"    = $1
   AND "queueId"     = $2
   AND service_date  = $3
   AND status        = 'DONE'
   AND "servedAt"   IS NOT NULL
   AND "completedAt" IS NOT NULL
 ORDER BY "completedAt" DESC
 LIMIT 20;   -- sampleSize * 2
```

Four things in that query are deliberate and each has a reason:

| Choice | Why |
|---|---|
| `service_date = $3` — **today only** | Doctors are not stationary processes. A Monday morning of routine follow-ups runs at four minutes a patient; the same doctor on Friday evening with complex cases runs at twelve. An all-time average tracks neither and is confidently wrong on both |
| `LIMIT 20` for a sample size of 10 | `usableSamples` then discards implausible durations (under 20s: a double-tap; over 2h: staff who forgot to press Done until the end of the session). Over-fetching 2× means the median still has real data after filtering, instead of silently falling back to the configured default |
| `ORDER BY "completedAt" DESC` | Newest first, so the window tracks the session that is actually happening |
| The **median** is taken in TypeScript, not `percentile_cont` in SQL | One 40-minute consultation among nine 5-minute ones drags the *mean* to 8.5 — an inflated estimate for everyone behind it, caused by an event that has already finished. The median (5) survives it. Computing it in the application keeps `estimateWait` a pure, unit-testable function with no database in its tests, and 20 integers is not a payload worth optimising |

The trade is stated honestly in `eta.ts`: a genuine slowdown takes a few samples longer to
show. **For this product stability beats responsiveness — patients forgive a queue that
speeds up.**

### "Does this device already hold a token here today"

```sql
-- Runs INSIDE the issuing transaction.
-- Uses tokens_deviceHash_queueId_serviceDate_idx.
SELECT id, "publicId"
  FROM tokens
 WHERE "tenantId"    = $1
   AND "queueId"     = $2
   AND service_date  = $3
   AND "deviceHash"  = $4
   AND status IN ('WAITING', 'CALLED', 'SERVING')
 LIMIT 1;
```

Scoped to **active** statuses so a patient who was already served, or who cancelled, can
legitimately take another token later the same day. The conflict response returns the
existing `publicId` so the phone can redirect to the token they already hold instead of
showing a dead end.

### Dispute resolution

```sql
SELECT a."createdAt", a.action, a.meta, u.name AS actor
  FROM audit_events a
  LEFT JOIN users u ON u.id = a."userId"
 WHERE a."tenantId"  = $1
   AND a."subjectId" = $2
 ORDER BY a."createdAt" ASC;
```

`LEFT JOIN`, because `userId` is null for self-service actions and `SET NULL` for deleted
staff. An inner join would silently drop exactly the rows most likely to be under dispute.

### The retention sweep

```sql
DELETE FROM tokens
 WHERE service_date < (CURRENT_DATE - $1::int)
 RETURNING id;
```

---

## 11. What this does not handle

**No `queue_hours`.** There is no representation of when a queue is open. The ETA therefore
cannot say "you will not be seen today" and `dailyCapacity` is the blunt stand-in. This is
the largest missing table in the schema and I would add it first.

**No token transfer between queues.** A patient sent from Dr. Perera to the pharmacy takes a
new token and starts at the back of the pharmacy line. A `TRANSFER` action would need to
decide whether the new token keeps the old wait — which is a product question, not a schema
one, and it has not been answered.

**No appointments.** Every token is a walk-in. A booked slot is a fundamentally different
model (a time, not a position) and grafting it onto `number` would produce something that is
neither.

**`audit_events` has no retention policy.** It grows with every action and nothing trims it.
Named in §9 as deliberate for now; it is a growth risk with a known shape.

**No partitioning.** `tokens` is one table. At the scale in §12 that is fine; the fix when it
is not is range partitioning on `service_date`, which is natural because every query already
filters on it.

**`features` JSON is unvalidated.** Nothing stops `{"maxQueues": "five"}`. A Zod schema at
the read boundary is the fix and it is not written.

**No soft delete on `tokens`.** A staff member who cancels the wrong token cannot undo it;
they issue a new one. `audit_events` records what happened, which settles the dispute but
does not restore the patient's position.

**The retention sweep is configured but not scheduled.** `TOKEN_RETENTION_DAYS` is validated
at boot and the idempotency `sweep()` method exists. Wiring both into a real scheduler with
observability is `01-ARCHITECTURE.md` §11's first "change".

---

## 12. What changes at 10× and 100×

Today's working assumption: one clinic, 3-6 queues, ~150 tokens a day, 400-day retention —
about 60,000 token rows. The whole platform fits on one small Postgres instance with room to
spare.

### At 10× — 50 clinics, ~3M token rows

**Mostly fine.** Every hot query is an index scan bounded by `(tenantId, serviceDate)` or by
`(queueId, serviceDate)`, so per-query work does not grow with platform size. Three things
start to matter:

1. **The retention sweep must actually run.** A `DELETE` of 400 days' accumulated rows in one
   statement is a long lock on a live table. Batch it: `DELETE … WHERE service_date < $1
   LIMIT 10000` in a loop, off-peak.
2. **`audit_events` overtakes `tokens`.** Several rows per token, no retention. The
   `(tenantId, createdAt)` feed query starts to feel it first.
3. **Connection pool sizing.** Each `issue` and `callNext` holds a transaction with a row
   lock. Long transactions plus a small pool is how a busy morning becomes a queue of waiting
   connections. Keeping the transaction short — which is why the capacity `COUNT` is the
   cheapest form available — is the mitigation that already exists.

### At 100× — 500 clinics, ~30M token rows

Now the design genuinely changes.

**1. Partition `tokens` by `service_date` range.** Natural, because **every query already
filters on `service_date`** — partition pruning comes free with no query rewrite:

```sql
CREATE TABLE tokens (…) PARTITION BY RANGE (service_date);
```

What it buys: the retention sweep becomes `DETACH PARTITION` + `DROP TABLE`, which is instant
and takes no lock on live data. `VACUUM` and index maintenance become per-partition and
therefore possible during business hours. Recent partitions stay small and hot.

What it costs: partition management, and the unique constraint must include the partition key
— which it already does, since it is `(queue_id, service_date, number)`. That is a fortunate
accident of getting the constraint right for a different reason.

**2. The `queue_counters` lock at a genuinely busy counter.** The lock serialises issuance
per queue per day. At a clinic door this is invisible. At a passport office issuing 3,000
tokens between 08:00 and 09:00 on one queue, transactions queue behind one row. *In order:*
shorten the transaction (the capacity `COUNT` is the expensive part and could become a
counter column on `queue_counters`), then split the queue — which is the real answer, because
a single line of 3,000 people is a product failure before it is a database one.

**3. A daily rollup table.** Reports currently range-scan `tokens` and aggregate. A
`queue_daily_stats` row written once at the service-date boundary makes the dashboard
O(days) instead of O(tokens), and lets the raw tokens be swept sooner without losing the
history an owner actually looks at.

**4. Read replica for reports.** Reporting tolerates staleness — a dashboard that is thirty
seconds behind is fine — while the hot path cannot. Splitting them means a heavy month-range
export cannot slow down "call next".

**5. `idempotency_keys` and `queue_counters` stay fine.** The first self-trims at 24 hours;
the second is one small row per queue per day — 500 clinics × 5 queues × 400 days is a
million rows of four columns, which is nothing. Both were designed correctly and do not
change.

### What does not change

The schema shape. Every table earns its place, every column has a reason, and the two
constraints the product rests on — the counter row lock and
`UNIQUE(queue_id, service_date, number)` — scale without coordination because they are
per-queue-per-day by construction. **The changes above are all operational: partitioning,
retention, rollups, replicas. None of them is a redesign.** That is the property worth
defending — the model is right, and scale is a question of where the rows physically sit.

---

## 13. Related documents

- `01-ARCHITECTURE.md` — components, the full life of one token, why SSE and Redis pub/sub
  rather than WebSockets or a Go service in v1, rejected alternatives, failure modes.
