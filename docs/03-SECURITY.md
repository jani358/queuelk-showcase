# 03 — Security

QueueLK runs a clinic's patient queue. Three of its surfaces are open to the entire
internet with no login at all: the TV display at `/d/[slug]`, the patient's phone page at
`/q/[slug]/[queue]` and `/t/[publicId]`. Anyone who can read a QR code poster taped to a
dispensary wall can reach them. Behind those sits a multi-tenant database holding, for
every clinic on the platform, who came in, when, how long they waited, and — optionally —
a hash of their phone number.

That combination is the whole security problem: an anonymous write path (taking a token),
an anonymous read path (the display), and medical-adjacent data on the other side of both.

This document is organised around a **threat model with named actors**. Each one gets a
section with the same four headings: the attack, what stops it, what does **not** stop it,
and the residual risk. Then the cross-cutting controls — PII, JWT design, cookies, config
validation — and at the end a blunt table of what is **not implemented in v1**.

That last table is not an apology. A security document claiming full coverage is a document
nobody should trust. The useful thing to know about a small product is exactly where its
edges are.

---

## 1. Threat model

### 1.1 What is worth attacking

| Asset | Why someone wants it | Worst realistic case |
|---|---|---|
| **`phoneHash` + `phoneLast4` on tokens** | A list of people who attended a medical clinic on a given day | The single worst leak in the system. See §7 for why it is a hash and not a number |
| **`patientName` on tokens** | Same, with the name attached | "These 40 people visited Dr. Perera on Tuesday" |
| **A tenant's token history** | Patient volume ≈ revenue. A rival knows exactly how busy you are | Competitive intelligence, priced in rupees |
| **`JWT_SECRET`** | Forge an access token with any `tid` | Total cross-tenant compromise. The crown jewel (§9) |
| **`JWT_REFRESH_SECRET`** | Mint refresh tokens, i.e. 7-day persistent access | Same, but quieter and longer-lived |
| **`DEVICE_COOKIE_SECRET`** | Forge unlimited device identities | Self-service abuse limits bypassed. Deliberately a *smaller* blast radius than the JWT secrets — that is why it is a third, separate secret |
| **Staff credentials** | Password reuse; queue manipulation | Console takeover for one tenant: cancel tokens, close queues, add staff |
| **Refresh tokens at rest** | 7 days of silent access without a password | Persistent access to one clinic's console |
| **A queue's live numbers** | Public by design (§3) | Nothing on its own — but see the volume-leak discussion |
| **`publicId` of one token** | Cancel a stranger's place in line | One patient loses their turn. Requires the device cookie too (§5) |

Note the asymmetry: `JWT_SECRET` is worth more than every token row in the database,
because it is the one value that lets an attacker mint a token for an arbitrary `tid`.
§9 exists to protect it.

### 1.2 Trust boundaries

```
 UNTRUSTED                                       │ TRUSTED
                                                 │
 Every anonymous phone in the waiting room       │  apps/api process
 Every TV display (it is just a browser)         │  Postgres (private network)
 Any request body, header, query parameter       │  Redis   (private network, non-authoritative)
 Any client-supplied id (queueId, tokenId,       │
   tenantSlug, publicId)                         │
 The device cookie ──────────────────────────────┼──► signed, so it is authentic, NOT authoritative
 `X-Forwarded-For` ──────────────────────────────┼──► only one hop is trusted
 The staff tablet itself ────────────────────────┼──► it walks out of the building
```

Two entries deserve comment.

**The device cookie is authentic but not authoritative.** The HMAC proves the server issued
that value. It proves nothing about whether the holder has had ten others. §2 is entirely
about the gap between those two statements.

**Redis is untrusted for correctness.** Not because anyone can write to it — it is on a
private network — but because it is allowed to *disappear*. Every control that must hold
when Redis is down lives in Postgres. This is stated in `redis.service.ts` and it is the
single most load-bearing design decision in this document.

### 1.3 Explicitly out of scope

- **Volumetric DDoS.** Application-layer limits cannot absorb it; the packets still reach
  the process. Cloudflare in front is the answer, listed in §13.
- **Host OS hardening**, physical security of the VPS, hypervisor escape at the provider.
- **Physical security of the clinic.** If someone can walk behind the counter and use an
  unlocked, logged-in tablet, no API control helps. §4 covers the *stolen* tablet, which is
  a different and more tractable problem.
- **Supply-chain attacks on npm** beyond a lockfile and `npm audit` in CI.
- **A patient photographing another patient's phone screen.** Real, unstoppable, and the
  disclosed data is one token number.

---

## 2. Actor 1 — A bored teenager taking 500 fake tokens

### 2.1 The attack

The clinic opens at 07:00. A QR poster on the wall points at
`https://queuelk.lk/q/sunrise-dispensary/A`. Someone scans it, sees that taking a token is
one tap with no login, opens DevTools on their phone or a laptop on the same wifi, finds
the `POST /api/public/queues/:id/tokens` call, and writes a five-line loop.

By 07:20 the queue shows 500 waiting. Every real patient's ETA says four hours. The
display is useless, the doctor's day is ruined, and the clinic phones you.

This is the attack that actually happens. It needs no skill, no motive beyond boredom, and
it is the reason the issuance path has four separate controls rather than one.

### 2.2 What stops it

Four layers, listed from the weakest and cheapest to the strongest and most expensive.

**Layer 1 — Per-IP sliding window in Redis (Lua, atomic).**

`RateLimitGuard` runs one Lua script per request against a Redis sorted set:

```lua
local key      = KEYS[1]
local now      = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit    = tonumber(ARGV[3])
local member   = ARGV[4]
local cutoff   = now - windowMs

redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, windowMs)
  return { 1, limit - count - 1, windowMs }
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local resetMs = windowMs
if oldest[2] then
  resetMs = (tonumber(oldest[2]) + windowMs) - now
  if resetMs < 0 then resetMs = 0 end
end
return { 0, 0, resetMs }
```

Three decisions in that script, each with a rejected alternative:

| Decision | Why | Rejected alternative |
|---|---|---|
| **Sliding window** (sorted set keyed by timestamp) | A fixed window resets on a clock boundary, so a caller sends `limit` requests at 07:59:59 and another `limit` at 08:00:00 — twice the intended rate at the seam | `INCR` + `EXPIRE`. Simpler, and it doubles the effective limit at exactly the moment someone is trying |
| **One Lua script** | Redis executes it atomically. Separate `ZREMRANGEBYSCORE`/`ZCARD`/`ZADD` round trips let two concurrent requests both read a count below the limit and both add — admitting both over it | Three round trips. For "take a token" that interleaving is precisely the bug we care about |
| **`PEXPIRE` on every allowed write** | Without it every distinct IP leaks a key forever, and a scanner walking a /16 fills Redis | No expiry, or a periodic sweep job. The sweep is another moving part for something `PEXPIRE` does for free |

The default is `SELF_TOKENS_PER_IP_PER_HOUR=5`, configurable because a clinic owner may
legitimately want it looser on a busy morning.

**Layer 2 — Per-device signed cookie limit.**

`DeviceMiddleware` guarantees every public request carries a verified device id, minting
one when absent. `RateLimitGuard.resolveIdentity` then prefers it over IP:

```ts
private resolveIdentity(request: GuardedRequest, options: RateLimitOptions): string {
  if (request.user?.userId) {
    return `user:${request.user.userId}`;
  }
  if (options.byDevice && request.deviceId) {
    return `device:${request.deviceId}`;
  }
  return `ip:${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;
}
```

The cookie is a 16-byte random id plus an HMAC-SHA256 signature over it, formatted
`<idHex>.<sigBase64url>`. Nothing else — no user id, no token id, no timestamp. It is a
pseudonym, not a session.

**Why signed at all.** Without a signature the attacker sets `qlk_device=whatever` and
mints a fresh identity per request with one header. With a signature they must obtain a
*server-issued* value for each identity, which costs a real round trip per identity — and
that round trip is itself subject to the IP limit. The signature converts "free unlimited
identities" into "one identity per request you were already allowed to make".

**Why not a JWT for the device cookie.** A JWT here would be 200+ bytes of base64 carrying
claims nobody reads, sent on every request from every phone in a waiting room, to express
one opaque identifier. HMAC over 16 random bytes is ~60 bytes and says exactly as much.

**Why `timingSafeEqual` and not `===`:**

```ts
const a = Buffer.from(signature);
const b = Buffer.from(expected);
if (a.length !== b.length) return null;
if (!timingSafeEqual(a, b)) return null;
```

A byte-by-byte `===` short-circuits on the first mismatch, so response latency leaks how
many leading bytes of a guessed signature were correct. That is enough to forge a signature
one byte at a time — the classic HMAC timing attack. The length check before the compare is
not redundant: `timingSafeEqual` throws on unequal lengths, and a thrown exception is
itself a timing signal.

Note also the shape check before any crypto runs:

```ts
if (!/^[0-9a-f]{32}$/.test(id)) return null;
```

That rejects garbage cheaply and, more importantly, keeps the buffers passed to
`timingSafeEqual` a predictable length.

**Layer 3 — ONE active token per device per queue, enforced inside the Postgres
transaction.**

This is the layer that actually holds, and its placement is the point:

```ts
if (input.deviceHash) {
  const existing = await tx.token.findFirst({
    where: {
      tenantId,
      queueId,
      serviceDate: on,
      deviceHash: input.deviceHash,
      status: { in: [...ACTIVE_STATUSES] },
    },
  });

  if (existing) {
    throw new ConflictException({
      error: 'AlreadyHasToken',
      message: 'This device already has an active token in this queue.',
      publicId: existing.publicId,
    });
  }
}
```

`tx` is the transaction client. This check runs in the **same transaction** that allocates
the number and inserts the row, under the `queue_counters` row lock taken by
`allocateNumber`. Two concurrent requests from the same device cannot both pass it, because
the second one blocks on the counter lock until the first has committed its token row.

**Why here and not in Redis.** Because `RateLimitGuard` fails **open**:

```ts
} catch (err) {
  this.logger.error(`Rate limit check failed, allowing request: ${String(err)}`);
  return true;
}
```

Redis being down must not take a clinic's queue offline. A waiting room that cannot issue
tokens is a worse outcome than one that briefly cannot throttle. But that decision is only
defensible because the limits protecting *correctness* are not in Redis. If the
one-token-per-device rule lived in Redis, then "Redis restarted" would silently mean
"anyone can mint unlimited tokens", and nobody would notice until the display showed 500.

Note the scoping to `ACTIVE_STATUSES`. A patient who was already served, or who cancelled,
can legitimately take another token later the same day — a person genuinely does come back
to the pharmacy counter after seeing the doctor.

**Layer 4 — `dailyCapacity`, also inside the transaction.**

```ts
if (queue.dailyCapacity !== null) {
  const issued = await tx.token.count({
    where: {
      tenantId,
      queueId,
      serviceDate: on,
      status: { not: TokenStatus.CANCELLED },
    },
  });

  if (issued >= queue.dailyCapacity) {
    throw new ConflictException(
      `This queue is full for today (${queue.dailyCapacity} tokens). Please come back tomorrow.`,
    );
  }
}
```

This is the hard ceiling, and it is a feature before it is a control. "Dr. Perera sees 40
patients, after that go home" is a real clinical requirement that clinics ask for by name.
It happens to also be the cheapest possible defence against mass minting: whatever an
attacker does, the queue cannot exceed 40 tokens.

The check runs **before** `allocateNumber`, inside the transaction, so a rejected token
cannot have consumed a number. That is precisely what an "allocate from Redis, then insert"
design cannot do — the number would already be spent and the display would show a gap where
a patient appears to have been skipped.

`CANCELLED` tokens release their slot: a patient who changed their mind should not consume
one of the doctor's forty appointments.

### 2.3 What does NOT stop it

Stated plainly, because pretending otherwise is how people ship holes.

| Non-defence | Why it fails |
|---|---|
| **The device cookie against a determined attacker** | Clearing cookies, or one private window, yields a new identity for free. `curl` without a cookie jar gets a fresh one on every request. The cookie raises the *cost* of casual abuse; it is not a wall |
| **IP limiting in a Sri Lankan waiting room** | Everyone in the room is behind one router on one NAT. Mobile-data users are behind carrier-grade NAT shared by thousands of SLT/Dialog/Mobitel subscribers. See §2.4 |
| **IP limiting against anyone with a phone** | Toggling airplane mode on mobile data commonly yields a new CGNAT egress IP. That is a five-second bypass with no tooling |
| **Rate limiting when Redis is down** | Fails open, by design. Layers 3 and 4 are what remain, and they are the ones that matter |
| **`SELF_TOKENS_PER_DEVICE_PER_DAY`** | Configurable to 50. A clinic that loosens it for a busy morning and forgets has loosened it permanently |
| **CAPTCHA** | Not implemented (§13). It would help against scripting and would also stop a 70-year-old patient from taking a token, which is a worse outcome than a spoiled queue |

### 2.4 The CGNAT problem, specifically

This deserves its own heading because it is the one where the Sri Lankan context changes
the answer.

Dialog, Mobitel, Hutch and SLT all place mobile subscribers behind carrier-grade NAT. A
single public IPv4 address can front thousands of handsets in a district. So:

- **A per-IP limit of 5/hour punishes bystanders.** Five patients in the same waiting room
  on the same mobile carrier can exhaust the bucket for everyone behind that egress IP,
  including people at other clinics on the platform.
- **It does not punish the attacker**, who toggles airplane mode.

This is why `resolveIdentity` puts IP **last**, after the authenticated user and the device
cookie, and why the comment in the guard says so explicitly. IP is the last-resort signal,
not the primary one. The genuinely load-bearing limits are per-device (cheap to evade but
free to apply) and per-queue-per-day in Postgres (impossible to evade).

It is also why `trust proxy` must be set to exactly the real hop count in production: with
it unset, `req.ip` is the proxy's own address and *every* visitor on the platform shares one
bucket. That turns a mild annoyance into a self-inflicted outage. See the deployment guide in the private repo
§5.5.

### 2.5 Residual risk

**A determined attacker with a script, a cookie jar reset, and a mobile connection can
fill a queue up to `dailyCapacity`.** That is the honest statement.

What that costs them: one HTTP round trip per token, each with a fresh cookie and
periodically a fresh IP. What it costs the clinic: a queue that hits its cap early, which
staff resolve by cancelling the fake tokens from the console (they are identifiable — same
`deviceHash` pattern, no `patientName`, all issued within minutes, `source = SELF`) and
raising the cap.

What it does **not** cost: any data, any other tenant, any patient's record. The blast
radius of this attack is one queue, one day, and an annoyed receptionist.

Mitigations if a real clinic is targeted repeatedly:
1. Set `dailyCapacity` to the real clinical number. Most clinics should anyway.
2. Switch the queue to `PAUSED` and issue from the counter only. One click, and it is the
   workflow the clinic used before QueueLK existed.
3. Build the "require a phone number for self-service" flag. Not in v1 — §13.

---

## 3. Actor 2 — A rival clinic reading your queue

### 3.1 The attack

There is no attack. That is what makes this section worth writing.

`GET /api/public/tenants/:slug/queues` requires nothing. No token, no cookie, no referrer
check. A rival dispensary two streets away opens `https://queuelk.lk/d/sunrise-dispensary`
in a browser, or curls the JSON behind it, and sees the live state of every queue.

They can put that in a cron job and have a year of your data.

### 3.2 What is actually exposed

From `QueueSnapshot`, which is the exact shape the display and the patient page both read:

| Field | Exposed | What it means to a rival |
|---|---|---|
| `name` | "Dr. Perera", "Pharmacy" | Which doctors work here and on which days |
| `prefix` | `A`, `PH` | Nothing |
| `status` | OPEN / PAUSED / CLOSED | When you actually open, when the doctor takes breaks |
| `nowServing.label` | `A-014` | **How many patients you have served today** |
| `nowServing.patientName` | "Nimal" | A patient's first name, if they chose to give one |
| `upNext` | 3 labels | Nothing beyond the above |
| `waitingCount` | `12` | Current demand |
| `servedToday` | `31` | **Patient volume, directly** |
| `averageServiceSeconds` | `420` | How fast your doctors work |
| `dailyCapacity` / `isFull` | `40` / `false` | Your maximum capacity |

### 3.3 What that actually leaks

Be concrete rather than hand-wavy about this, because "it's just a queue number" is how
products under-think their public surface.

**Patient volume is revenue.** A GP consultation in Sri Lanka runs roughly Rs 1,000–2,500.
A rival polling `servedToday` at 20:00 every evening learns your daily patient count to the
person. Over a month that is your gross revenue, ±10%, for free. That is genuinely
commercially sensitive information, and the clinic owner would not hand it over if asked.

**Staffing patterns.** `status` transitions expose when each doctor arrives, when they take
breaks, and when they leave. A rival recruiting a doctor knows their schedule.

**A patient's first name.** `nowServing.patientName` is on the public display by design —
it is the courtesy line "Now serving A-014 — Nimal" that makes a noisy waiting room work.
It is optional, and the product should keep it optional, but it is genuinely public: a
stranger on the internet can read the first name of the person currently with the doctor.

**Trend data, if someone bothers.** Nobody is polling a dispensary's queue in practice. But
the data would support it, and "nobody bothers" is not a control.

### 3.4 Mitigation options NOT taken in v1, and why

| Option | What it would buy | Why not in v1 |
|---|---|---|
| **Obscure slug** (`/d/sunrise-dispensary-7f3a9c`) | Raises the cost of *finding* the display from "guess the clinic name" to "obtain the URL" | The slug is printed on a QR poster on the wall and typed into a TV's browser by a receptionist. A URL that a human has to type correctly onto a cheap Android TV remote must be short and memorable. And an obscure slug is security by obscurity: it leaks the first time anyone photographs the poster, which is every day |
| **Display token** (a secret query parameter the display holds) | Real access control on `/d/` | It has to be provisioned onto the TV, survive a reboot, and be re-entered when the browser clears storage — with a remote control, by a receptionist, at 07:00 with patients waiting. The support cost is enormous and the thing protected is a number already shouted across the room |
| **Rate-limit the public snapshot** | Bounds bulk scraping | It does not stop one poll per minute, which is all a rival needs. And it risks throttling a waiting room full of phones, which is the legitimate traffic |
| **Strip `servedToday` / `averageServiceSeconds` from the public payload** | Removes the volume leak specifically | **DONE — this is implemented.** See §3.5 below |

### 3.5 What was actually done about it

The last row of that table is no longer a proposal. `PublicService.toPublicQueue()` projects the
queue snapshot before it leaves the public endpoints, dropping exactly two fields:

```ts
private toPublicQueue(queue: QueueSnapshot): PublicQueueSnapshot {
  const { servedToday: _servedToday, averageServiceSeconds: _avg, ...rest } = queue;
  return rest;
}
```

The type is expressed as an `Omit` rather than a hand-written interface —

```ts
export type PublicQueueSnapshot = Omit<QueueSnapshot, 'servedToday' | 'averageServiceSeconds'>;
```

— so a field added to `QueueSnapshot` later appears on the public type automatically and has to be
considered, rather than being silently withheld or silently leaked. When this change was made, the
compiler immediately flagged the one component that had been reading the full shape.

The concern about splitting `snapshot()` turned out not to apply: the projection happens at the
*edge*, in `PublicService`, so all three surfaces still derive from one `QueuesService.snapshot()`
and cannot disagree about "now serving". Only the serialisation differs.

Two integration tests hold the line in both directions — one asserts the metrics are absent from
`/api/public/d/:slug`, the other asserts they are still present on the authenticated
`/api/queues/live`, because a future "tighten the public API" change that also hid the waiting count
would break the product rather than secure it.

What remains public is unchanged and deliberate: the number now serving, who is next, and how many
are waiting.

### 3.6 Residual risk, stated honestly

Stripping those two fields removes the *sharpest* signal, not the whole class of them.

**A rival can still determine your opening hours, your doctor schedule, and a usable approximation
of your patient volume by polling a public URL.** Watching `nowServing` climb from `A-001` to
`A-038` over a day yields the day's throughput without `servedToday` ever being exposed; timing the
gaps between changes approximates consultation length without `averageServiceSeconds`.

The counter-argument, which is real but not a complete answer: the number on the display is
*already* public. It is on a screen in a room anyone can walk into. Making it visible to
someone who is not in the room is a change of degree, not of kind — but a change of degree
from "one person can count" to "a script can record a year" is a meaningful one, and this
document should not pretend otherwise.

What a clinic should be told, in the settings page next to the display URL:

> This display page is public. Anyone with the link can see your queue numbers, how many
> patients you have served today, and your current waiting count. Do not enable patient
> names on the display if that matters to you.

---

## 4. Actor 3 — A staff tablet stolen from a counter

### 4.1 The attack

A Rs 25,000 Android tablet sits on the counter of a dispensary in Maharagama, logged into
`/console`, all day. At 18:00 it is not there.

Whoever has it holds: a valid access token in the page's JavaScript memory, and an httpOnly
refresh cookie good for 7 days. They can call patients, cancel tokens, close queues, read
every token row for that tenant including `patientName` and `phoneLast4`, and — if the
account is OWNER — create a new staff user for themselves.

### 4.2 What stops it

**The access token is 15 minutes.**

```ts
const accessTtl = this.config.get<string>('jwt.accessTtl', '15m');
```

Two costs balanced directly:

- **Longer (24h):** a stolen token works for a day. Deactivating the user does nothing
  until it expires.
- **Shorter (1m):** a refresh round trip every minute, more load, and worse behaviour on
  exactly the flaky clinic wifi this product lives on.

Fifteen minutes bounds the damage from the token itself while keeping refresh traffic
negligible.

**The token is held in JavaScript memory, not `localStorage`.** `localStorage` persists
across tabs and reboots and is readable by any script on the page. In-memory means a page
refresh loses it and the client silently re-refreshes from the httpOnly cookie — one extra
request for a meaningful reduction in what an XSS payload can walk away with.

**The user row is re-read from the database on EVERY request.**

```ts
async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
  const user = await this.auth.validateUserById(payload.sub);

  if (!user) {
    throw new UnauthorizedException('User no longer exists');
  }

  if (!user.isActive) {
    throw new UnauthorizedException('This account has been deactivated');
  }

  if (user.tenantId !== payload.tid) {
    throw new UnauthorizedException('Token does not match the user record');
  }

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,      // ← from the ROW, not the token
    tenantId: user.tenantId,
  };
}
```

This is the control that makes the operational answer work. A purely stateless JWT would be
faster — verify the signature, trust the claims, no I/O. QueueLK does one indexed
primary-key read per authenticated request instead.

| Scenario | Stateless JWT | With the DB check |
|---|---|---|
| Staff member deactivated | Works for up to 15 min | Rejected on the **next request** |
| Tenant deleted (cascade removes users) | Works for up to 15 min | Rejected on the next request |
| OWNER demoted to STAFF | Still OWNER for up to 15 min | STAFF immediately — `role` comes from the row |
| Tablet stolen, user deactivated | Up to 15 more minutes of access | Access gone at once |

The cost is a sub-millisecond primary-key lookup on a warm Postgres over a private network,
with Prisma's pool meaning no new connection. For this product the trade is obvious: "the
tablet is gone, kill their access" is said out loud by a clinic owner while standing at the
counter, and "it will take effect within fifteen minutes" is not an acceptable reply.

This also gives QueueLK **immediate revocation with no denylist** — no Redis set of revoked
`jti`s to maintain, expire, and get wrong.

**Refresh rotation with reuse detection.**

Every refresh burns the presented token and issues a new one:

```
Login
  └─► RT1 (active)

POST /api/auth/refresh  with RT1
  ├─ RT1 → revokedAt = now()
  └─► RT2 (active)

POST /api/auth/refresh  with RT2
  ├─ RT2 → revokedAt = now()
  └─► RT3 (active)
```

Now the theft:

```
Thief has the tablet, which holds RT2.

Case A — thief refreshes first:
  thief:  refresh(RT2) → RT2 revoked, thief holds RT3
  clinic: refresh(RT2) → ALREADY REVOKED
                          ↳ REUSE DETECTED
                          ↳ revokeAllForUser(userId)  ← RT3 dies too
                          ↳ the thief's session is dead

Case B — the clinic refreshes first (on a replacement device):
  clinic: refresh(RT2) → RT2 revoked, clinic holds RT3
  thief:  refresh(RT2) → ALREADY REVOKED
                          ↳ same outcome; the thief never gets back in
```

The code:

```ts
if (stored.revokedAt) {
  // REUSE DETECTED. Nuke every session for this user.
  this.logger.warn(
    `Refresh token reuse detected for user ${stored.userId} — revoking all sessions`,
  );
  await this.revokeAllForUser(stored.userId);
  throw new UnauthorizedException('Refresh token reuse detected. Please log in again.');
}
```

**Why revoke everything rather than just the reused token.** At the moment of detection the
server cannot tell thief from owner — both present identical bytes. Revoking only the reused
token leaves whichever descendant the thief just obtained alive. Killing the family is
correct even though the honest user is logged out too. A forced re-login is a small price
for terminating a live compromise.

**Revoke-then-issue is one transaction.** A crash between the two would leave the old token
live alongside a new one, quietly defeating rotation:

```ts
return this.prisma.$transaction(async (tx) => {
  await tx.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return this.issueTokens(stored.user, tx);
});
```

**The refresh path also re-checks `isActive`:**

```ts
if (!stored.user.isActive) {
  throw new UnauthorizedException('This account has been deactivated');
}
```

So deactivation kills both halves of the session, not just the access token.

**Refresh tokens are hashed at rest — SHA-256, not bcrypt.**

| | Password | Refresh token |
|---|---|---|
| Chosen by | A human | `randomBytes(32)` CSPRNG, embedded as `jti` in a signed JWT |
| Entropy | Maybe 30 bits, realistically | 256+ bits |
| Guessable from a dictionary? | Yes. That is the whole problem | No. There is no dictionary of 2²⁵⁶ values |
| Verified how often? | Once per login | Every 15 minutes per active session |
| Right primitive | Slow KDF (bcrypt) | Fast cryptographic hash (SHA-256) |

bcrypt's slowness exists to make *guessing* expensive. There is nothing to guess here.
Using bcrypt would add ~250 ms to every refresh — a permanent per-request tax that buys
literally zero security. SHA-256 is also deterministic and unsalted, which is what makes the
`@unique` index on `tokenHash` possible, and it is harmless because tokens are never
identical — the random `jti` guarantees it.

The scenario this addresses is a read-only database dump: a bad backup, a restore gone
wrong. With plaintext refresh tokens the attacker gets working 7-day sessions for every
logged-in user. With hashes they get nothing usable.

### 4.3 What does NOT stop it

**Fifteen minutes is fifteen minutes.** Before anyone notices the tablet is gone, the
holder can:

| Action | Possible in 15 min? | Damage |
|---|---|---|
| Read every token row for that tenant | **Yes** | `patientName`, `phoneLast4`, `note` ("wheelchair", "came with baby"), full day history |
| Cancel every waiting token | **Yes** | The queue is destroyed. Recoverable only by re-issuing at the counter |
| Close every queue | **Yes** | The display says "closed". One click each to reopen |
| Create a new OWNER account for themselves | **Yes, if the stolen account is OWNER** | **Persistent access that surviving the tablet's revocation.** This is the worst outcome and the reason §4.5 exists |
| Change the tenant slug | Yes | Every printed QR poster stops working |
| Read another tenant's data | **No** | `tid` comes from the token and is re-checked against the user row (§6) |
| Change a password without the old one | Yes, via `UpdateStaffDto.password` if OWNER | Locks the real owner out |
| Export the database | No | There is no export endpoint in v1 |

**The refresh cookie survives a screen lock.** `httpOnly` protects against script access,
not against someone holding the physical device with the browser already open. The
tablet-in-hand threat is not an XSS threat.

**Nothing detects the theft.** Reuse detection fires only if *both* parties refresh. If the
clinic simply stops using that tablet and never triggers a refresh from it, the thief's
session rotates happily for seven days and nothing is logged beyond ordinary activity.

### 4.4 The operational answer

There is no cryptographic fix for a device that walks away logged in. The answer is a
procedure, and it must be documented for clinics rather than assumed:

```
1. Another OWNER logs into /dashboard from any device.
2. Staff → the stolen device's user → Deactivate.
   (isActive = false)
3. Done. The next request from that tablet — within seconds, because the console
   polls — returns 401 'This account has been deactivated'.
   Its refresh also fails: AuthService.refresh checks isActive.
4. Review audit_events for that userId since the theft (§8) to see what was done.
5. Re-issue any cancelled tokens at the counter.
```

Step 2 is why `User.isActive` exists as a soft disable rather than a delete. Deleting the
row would cascade `RefreshToken` away (good) but would also `SetNull` every
`AuditEvent.userId` — erasing the record of what that account did, at exactly the moment
someone needs to read it.

The whole procedure is effective in **under one second** because of the per-request database
read in §4.2. That is the payoff for the one extra query.

### 4.5 Residual risk

**The 15-minute window is real and unavoidable**, and the worst thing inside it is an OWNER
creating a second OWNER account. That account survives deactivating the first one, and
nothing in v1 alerts on "a new OWNER was created".

Concretely: a stolen OWNER tablet is a potential *persistent* compromise of one tenant, not
a 15-minute one. The mitigations that would close it, none of them in v1:

1. **Email alert on staff creation and role change.** Cheapest real fix. The clinic owner
   gets "A new OWNER account (x@y.lk) was created at 18:04" and knows immediately.
2. **Require a password re-entry for OWNER-level changes** (creating staff, changing roles,
   changing the slug). Standard sudo-mode. Half a day of work.
3. **Shorter access TTL for OWNER sessions**, e.g. 5 minutes. Cheap, and slightly annoying.

Recorded in §13. Item 1 is the one to build first.

A smaller residual: **there is no idle timeout.** A tablet logged in at 07:00 is still
logged in at 19:00 as long as the page stays open and refreshes keep succeeding. For a
device that lives on a counter that is the desired behaviour — staff should not have to log
in every hour — but it means "logged in all day" is the normal state, which is what makes
the theft valuable.

---

## 5. Actor 4 — Display URL guessing, and the `publicId` that IS a secret

### 5.1 The attack

Two different attacks that look similar and have opposite answers.

**(a) Guessing a display URL.** `/d/sunrise-dispensary`. Slugs are derived from the clinic
name, so they are guessable by anyone who knows a clinic exists — which is everyone who
walks past it.

**(b) Guessing a patient token URL.** `/t/<publicId>`. If that identifier were sequential
or derived from the token number, an attacker enumerates it and can read — and **cancel** —
every patient's token in the clinic.

### 5.2 The slug is not a secret, on purpose

```prisma
/// Public URL segment: /d/sunrise-dispensary, /q/sunrise-dispensary/A.
/// Unique globally because it appears in a URL with no other qualifier.
slug String @unique @db.VarChar(60)
```

The slug is printed on a QR poster taped to the clinic wall, typed into a TV browser by a
receptionist with a remote control, and read aloud over the phone to a staff member setting
up a second display. Every one of those uses requires it to be short, memorable and
typeable. A secret that is displayed on a wall is not a secret, and designing as though it
were is how products end up with a control that everyone quietly works around.

So it is treated as public, and the things behind it are exactly the things §3 lists as
acceptable to publish. Nothing behind `/d/[slug]` should ever be something you would mind a
stranger reading — that is the design rule, and every new field added to `QueueSnapshot`
has to be checked against it.

The slugify function is worth one note:

```ts
private slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return base || `clinic-${randomBytes(4).toString('hex')}`;
}
```

Sinhala and Tamil characters are stripped rather than transliterated, so an all-Sinhala
clinic name produces an empty base. The random suffix guarantees the result is always a
usable identifier rather than an empty path segment — which would otherwise be a crash or,
worse, a collision with another all-Sinhala name.

Registration returns a 409 naming the slug when one collides:

```ts
throw new ConflictException(
  `A location with a similar name already exists (slug "${slug}"). Try a more specific name.`,
);
```

That leaks the existence of an *organisation*, not a user. Organisation names are public by
nature — they are on a signboard — so this is an accepted leak rather than an oversight.
Registration is rate-limited to 5/hour per IP, which bounds bulk probing.

### 5.3 The `publicId` IS a secret

```ts
/**
 * Unguessable public handle.
 *
 * 16 bytes (128 bits) of CSPRNG, base64url. The URL /t/<publicId> is the
 * patient's ONLY credential — it is what their phone bookmarks and what
 * authorises cancelling their own token — so it must not be enumerable. A
 * sequential id, or anything derived from the token number, would let anyone
 * walk the whole clinic's traffic and cancel strangers' places in line.
 */
private generatePublicId(): string {
  return randomBytes(16).toString('base64url');
}
```

**Why 128 bits from a CSPRNG.** 16 bytes base64url-encodes to 22 characters. At 128 bits
the search space is 2¹²⁸; an attacker making a million guesses per second against a rate-
limited endpoint would need longer than the age of the universe to find one live token, and
the clinic's tokens are deleted after `TOKEN_RETENTION_DAYS` anyway.

**`randomBytes`, not `Math.random()`.** `Math.random()` is a PRNG seeded from the process
and is not cryptographically secure — given enough outputs its internal state is
recoverable, and then every future `publicId` is predictable. `crypto.randomBytes` reads
from the OS CSPRNG.

**Why not the token number.** Spell out the consequence, because this is the mistake the
design exists to prevent. If `/t/A-014` worked:

| Attack | Consequence |
|---|---|
| `for n in 1..100: GET /t/A-$n` | The full day's traffic for the clinic: every patient's name, status, issue time, and phone last-4 |
| `POST /t/A-014/cancel` for every n | Every patient in the building loses their place in line, and the console shows them as cancelled by "the patient" |
| Watch `/t/A-030` before arriving | Not an attack, but it makes the "credential" meaningless |

That first row is a patient-data breach delivered by a `for` loop. The `publicId` is the
single control preventing it.

**Why not a UUIDv4.** It would be fine — 122 bits of randomness — but it is 36 characters
with hyphens instead of 22, and this string goes into a URL that a patient's phone
bookmarks and that may be shown as a QR code. Shorter is better when the same entropy is
available.

**Uniqueness.** `publicId String @unique @db.VarChar(32)`. At 128 bits, a collision across
every token the platform will ever issue is not a practical concern, but the unique
constraint means a collision is a failed insert rather than two patients sharing a page.

### 5.4 Knowing the `publicId` is not enough to cancel

The patient cancel path requires **two** proofs:

```ts
async cancelByPatient(params: {
  publicId: string;
  deviceHash: string;
}): Promise<TokenView> {
  const token = await this.prisma.token.findUnique({
    where: { publicId: params.publicId },
    include: { queue: true },
  });

  if (!token) {
    throw new NotFoundException('Token not found');
  }

  if (!token.deviceHash || token.deviceHash !== params.deviceHash) {
    throw new ForbiddenException(
      'This token was taken on a different device. Ask the counter staff to cancel it.',
    );
  }

  return this.act({
    tenantId: token.tenantId,
    tokenId: token.id,
    action: TokenAction.CANCEL,
  });
}
```

Requiring both is deliberate and each half covers the other's weakness:

- **The `publicId` alone** would let anyone who glimpsed a screenshot, or saw the phone over
  someone's shoulder in a queue, cancel their place.
- **The device alone** would not identify *which* token.

Together they are a reasonable proof for an action whose worst outcome is losing your own
turn. Note the failure message names the remedy — "ask the counter staff" — because a
patient who changed phones mid-visit is a real case, and staff *can* cancel from the console
where the action is attributed to a named user in `audit_events`.

Note also `!token.deviceHash ||` — a counter-issued token has no `deviceHash`, so it can
never be cancelled from a phone at all. Correct: nobody scanned anything to get it.

### 5.5 Residual risk

**Reading a token page requires only the `publicId`:**

```ts
/** The patient's own view. Public — authenticated by knowing the publicId. */
async findByPublicId(publicId: string): Promise<TokenView> { ... }
```

So someone who obtains the URL — a screenshot in a WhatsApp family group, a shared phone, a
photo over a shoulder — can *watch* that token: its status, position, ETA, the patient's
name and phone last-4. They cannot cancel it without the device cookie.

That is the intended trade. The page must work when a patient sends it to a family member
who is bringing them to the clinic, which is an extremely common real usage in Sri Lanka.
Requiring the device cookie to *read* would break that, and the disclosed data — one
person's place in one queue — does not justify it.

**The device cookie can be lost.** A patient who clears cookies, switches from Chrome to
the WhatsApp in-app browser, or moves to another phone still has their `publicId` and can
still read the page — but can no longer cancel. The error message routes them to the
counter, which is the right answer, but it is friction that a patient will experience as a
bug.

---

## 6. Actor 5 — A malicious or careless staff member

### 6.1 The attack

A receptionist who was passed over for a raise cancels twenty waiting tokens at 11:00 and
says the system did it. Or, far more commonly and just as damaging: a new staff member
taps "No show" instead of "Recall" fourteen times in a morning and nobody knows why
patients are complaining.

They have legitimate credentials. Every action they take is an action they are authorised
to take.

### 6.2 What stops it

**Nothing, and the design says so.** From the schema:

```prisma
/// Append-only record of staff actions on tokens.
///
/// Small clinics have disputes — "I was here before her". A timestamped record of
/// who called what, and when, settles it in ten seconds. It is also the honest
/// answer to "what if a staff member cancels tokens maliciously": we cannot stop
/// someone with legitimate access, but we can make it visible.
model AuditEvent {
  id        String   @id @default(uuid())
  tenantId  String
  userId    String?
  action    String   @db.VarChar(60)
  subjectId String?  @db.VarChar(36)
  meta      Json     @default("{}")
  createdAt DateTime @default(now())
  ...
  @@index([tenantId, createdAt])
  @@index([tenantId, subjectId])
}
```

The answer to insider misuse is not prevention — it is **attribution**. Every state change
writes an audit row inside the same transaction as the change itself:

```ts
await tx.auditEvent.create({
  data: {
    tenantId,
    userId: actorId ?? null,
    action: `token.${action.toLowerCase()}`,
    subjectId: updated.id,
    meta: {
      queueId: queue.id,
      number: updated.number,
      from: current.status,
      to: updated.status,
    } as Prisma.InputJsonValue,
  },
});
```

Three properties make it useful rather than decorative:

**It is written in the same transaction as the change.** If the token update commits, the
audit row commits. There is no path where an action happens and the record does not, which
is the failure mode that makes most audit logs untrustworthy.

**It records `from` and `to`.** "Nimali set A-014 from WAITING to CANCELLED at 11:04" is a
sentence a clinic owner can act on. "Nimali did something to A-014" is not.

**`subjectId` is deliberately not a foreign key.**

```prisma
/// The affected token / queue id. Not a foreign key on purpose: audit rows must
/// survive the deletion of what they describe, which a FK with cascade would
/// prevent and a FK with restrict would make deletion impossible.
subjectId String? @db.VarChar(36)
```

An audit trail that vanishes when the subject is deleted is an audit trail that can be
erased by deleting the subject. Similarly `userId` is `onDelete: SetNull` rather than
cascade — deleting a staff member anonymises their history rather than destroying it, which
is why the product deactivates instead of deleting (§4.4).

**`userId` is null for self-service actions**, which is how you distinguish "the patient
cancelled" from "staff cancelled on the patient's behalf". That distinction is the entire
point in a dispute.

### 6.3 What does NOT stop it

| Non-defence | Why |
|---|---|
| **Roles** | OWNER and STAFF. Both can call, cancel, no-show. That is correct: a queue where counter staff cannot cancel a token is a queue staff will work around by leaving tokens hanging |
| **The audit log itself, against an OWNER** | There is no read-only enforcement at the database level in v1. An OWNER with database access (self-hosted) can delete rows. Append-only is a code property, not a Postgres grant |
| **Nobody reads it** | The single biggest weakness. There is no UI for `audit_events` in v1 — it is queried with `psql`. An audit log with no reader is a log that deters nobody |
| **Timing** | Nothing alerts on "20 cancellations in 3 minutes". That pattern is trivially detectable and is not detected |

### 6.4 Residual risk

**A staff member can destroy a day's queue and it will only be noticed by the consequences,
not by the system.** The audit table will explain what happened afterwards, to whoever
thinks to look and knows how to write SQL.

The honest priority order for closing this, none of it in v1:

1. **An audit view in the dashboard**, filtered by user and date. Without a reader the
   table is worthless. Half a day of work and it converts an unused table into a real
   control.
2. **A daily digest to the OWNER**: "Yesterday: 34 served, 2 no-shows, 1 cancellation by
   staff." Anomalies become visible without anyone querying anything.
3. **A `REVOKE DELETE` grant** on `audit_events` for the application role, so append-only is
   enforced by Postgres rather than by convention.

Recorded in §13.

---

## 7. Actor 6 — Cross-tenant access

This is the control the entire product rests on. If it fails, a clinic in Galle reads a
clinic in Jaffna's patient list, and QueueLK is unsellable.

### 7.1 The rule

> **Every query that touches a tenant-owned row carries `tenantId` in its `WHERE` clause,
> and that `tenantId` comes from the verified JWT.**

Not "the service checks ownership afterwards". Not "the guard already proved they are an
OWNER". In the `WHERE` clause, on every query, with no exception for trusted callers.

The schema makes it mechanical. From its header comment:

```
The governing rule of this schema: EVERY tenant-owned table carries `tenantId`
and every query filters on it in the WHERE clause. Not "the service layer
remembers to" — the column exists so the filter is expressible in SQL, and the
composite indexes are ordered (tenantId, ...) so the filtered query is also the
fast query. A tenant filter that makes queries slower is a filter people delete.
```

That last sentence is the design insight. `@@index([tenantId, serviceDate])` on `tokens`
means the tenant-scoped query is *faster* than the unscoped one. A safety rule that costs
performance gets deleted during the first slow-query investigation; a safety rule that
improves performance survives.

### 7.2 Where `tenantId` comes from — and where it never comes from

```ts
export interface JwtPayload {
  sub: string;
  email: string;
  role: Role;
  tid: string;   // ← the important one
}
```

`tid` is read from the **verified** token, after the HS256 signature check, and cross-checked
against the stored user row in `JwtStrategy.validate`. It is never read from:

| Source | Why it is never trusted |
|---|---|
| A body field `tenantId` | The attacker writes the body. One field away from a cross-tenant read |
| A header `X-Tenant-Id` | Same. A header is client-controlled input |
| A query parameter `?tenantId=` | Same, plus it lands in access logs |
| A path segment `/tenants/:id/queues` | Same. This is why the staff routes are `/api/queues`, not `/api/tenants/:id/queues` — there is no id in the URL to tamper with |
| A cookie | `qlk_refresh` is httpOnly and scoped to `/api/auth`; nothing reads a tenant from it |

The global `ValidationPipe` runs with `whitelist: true` and `forbidNonWhitelisted: true`, so
a client sending `{"name": "X", "tenantId": "<victim>"}` does not get the field silently
stripped — it gets a `400` naming the property. Silent stripping hides an attack in
progress, and hides a client bug too.

The **public** surfaces take a `slug`, not a tenant id, and resolving it grants exactly one
capability: reading that tenant's already-public queue state, or issuing a token into it.
The slug is not a credential and is never treated as one (§5.2).

### 7.3 The canonical bug: `findUnique` vs `findFirst`

The most common multi-tenant vulnerability in the Prisma ecosystem, and it is one word long.

```ts
// WRONG. Returns ANY tenant's queue to anyone who guesses a UUID.
const queue = await this.prisma.queue.findUnique({ where: { id: queueId } });

// RIGHT. Wrong tenant ⇒ zero rows ⇒ 404.
const queue = await this.prisma.queue.findFirst({ where: { id: queueId, tenantId } });
```

`findUnique` accepts only unique fields, which is exactly why it is dangerous: `id` is
unique, so the type checker is happy, the code compiles, and the tests pass — because the
tests use one tenant.

`QueuesService.findOne` is the canonical implementation, with the reasoning in the code:

```ts
async findOne(tenantId: string, queueId: string): Promise<Queue> {
  const queue = await this.prisma.queue.findFirst({
    // tenantId in the WHERE, not checked after the fetch. A findUnique by id
    // followed by an `if (queue.tenantId !== tenantId)` is one forgotten line
    // away from a cross-tenant read; this cannot be forgotten because there is
    // no version of the query without it.
    where: { id: queueId, tenantId },
  });

  if (!queue) {
    // 404, not 403. Telling a caller "this exists but is not yours" confirms
    // the id is real, which is a free enumeration oracle.
    throw new NotFoundException('Queue not found');
  }

  return queue;
}
```

**Why not fetch-then-compare.** `const q = await findUnique({id}); if (q.tenantId !== tenantId) throw;`
does work — until someone adds an early return above the check, or a `select` that omits
`tenantId`, or a cache. More subtly it leaks existence through timing: the fetch succeeded,
so the response is measurably slower for an id that exists than for one that does not.
Putting the filter in the `WHERE` makes the database enforce it, and the database does not
have early returns.

**Why 404 and not 403.** A `403` says "this exists, but not for you", which turns the
endpoint into an enumeration oracle. UUIDs are not guessable in practice, but the principle
costs nothing to apply and the habit is worth more than any individual case.

The same shape appears on every write. `TokensService.act` scopes the lookup and *also* the
conditional update:

```ts
const token = await tx.token.findFirst({ where: { id: tokenId, tenantId } });
if (!token) {
  throw new NotFoundException('Token not found');
}
...
const { count } = await tx.token.updateMany({
  where: {
    id: current.id,
    tenantId,                 // ← again, on the write
    status: current.status,   // ← plus the optimistic precondition
  },
  data: { ... },
});
```

`updateMany` rather than `update` is deliberate: `update` matches on the primary key only
and would happily overwrite a row another path had already moved. `updateMany` can express
both the tenant filter and the status precondition in its `WHERE`, and reports how many rows
it touched — so `count === 0` is a detectable conflict rather than a silent wrong answer.

And in raw SQL, where Prisma's types are not helping:

```sql
SELECT id, last_number
  FROM queue_counters
 WHERE "queueId" = $1
   AND "tenantId" = $2        -- ← redundant for correctness, kept on purpose
   AND service_date = $3
   FOR UPDATE
```

The code says why:

```ts
// tenantId is in the predicate even though (queueId, serviceDate) is already
// unique: it costs nothing and it means this query, read in isolation during a
// code review, is visibly tenant-scoped like every other query in the system.
```

That is a real argument for redundancy: the reviewer scanning for "does every query have a
tenant filter" should never have to reason about whether a particular one is exempt.

### 7.4 Isolation in the realtime layer

Tenant isolation has to hold in Redis pub/sub too, and it does — structurally:

```ts
static tenantChannel(tenantId: string): string {
  return `qlk:t:${tenantId}`;
}

static queueChannel(tenantId: string, queueId: string): string {
  return `qlk:t:${tenantId}:q:${queueId}`;
}

static tokenChannel(tenantId: string, publicId: string): string {
  return `qlk:t:${tenantId}:tok:${publicId}`;
}
```

Tenant id is the **first** segment of every channel, and there is no wildcard subscribe
anywhere in the codebase. A subscriber builds its channel name from its own verified tenant,
so a subscription cannot accidentally span tenants. If someone ever adds a `PSUBSCRIBE
qlk:t:*` for a debugging dashboard, that is the line that breaks this property, and it
should be caught in review.

### 7.5 No platform superuser

```ts
const RANK: Record<Role, number> = {
  [Role.OWNER]: 2,
  [Role.STAFF]: 1,
};
```

From the guard's own comment:

> Note what this guard does NOT do: it never crosses tenants. There is no platform
> superuser role, because a role that can read every clinic's patient queue is the single
> most valuable credential in the system.

This costs something real. Support is harder: when a clinic says "the display shows the
wrong number", nobody can log in and look. The workflow is a screen-share, or asking the
owner to create a temporary STAFF account inside their own tenant. For a one-person business
that is genuinely annoying.

It is still right at this size:

1. **The credential cannot leak if it does not exist.** A superuser account is one password
   whose compromise is a total breach of every clinic's patient data.
2. **A flag on a user row is not an access mechanism.** The moment support access is a
   boolean, it gets set during an incident and never unset.
3. **The honest version is expensive.** Proper support access is time-boxed,
   customer-approved, revocable and audited — which needs the audit *view* from §6.4 first.
   Building half of it is worse than building none.

When this changes: at the point where screen-shares do not scale, the correct build is a
short-lived, customer-initiated, logged impersonation grant — the clinic clicks "allow
support access for 1 hour" and every action in that window is written to `audit_events` with
a distinguishing `action` prefix.

### 7.6 The integration test that proves it

Tenant isolation is the claim that most needs a test, because it is the claim easiest to
break with an innocent-looking refactor.

```ts
describe('tenant isolation', () => {
  let alpha: { tenantId: string; token: string; queueId: string; tokenId: string };
  let beta:  { tenantId: string; token: string; queueId: string; tokenId: string };

  beforeAll(async () => {
    // Two clinics registered through the REAL /api/auth/register endpoint,
    // each with one queue and one issued token.
    alpha = await registerClinicWithToken('Sunrise Dispensary', 'A');
    beta  = await registerClinicWithToken('Lakmal Medical',     'B');
  });

  it('refuses to read another tenant\'s queue by id', async () => {
    await request(app.getHttpServer())
      .get(`/api/queues/${beta.queueId}`)
      .set('Authorization', `Bearer ${alpha.token}`)
      .expect(404);                       // 404, not 403 — no existence leak
  });

  it('refuses to act on another tenant\'s token', async () => {
    await request(app.getHttpServer())
      .post(`/api/tokens/${beta.tokenId}/call`)
      .set('Authorization', `Bearer ${alpha.token}`)
      .expect(404);

    // And the token must be untouched, not merely un-responded-to.
    const row = await prisma.token.findUniqueOrThrow({ where: { id: beta.tokenId } });
    expect(row.status).toBe('WAITING');
    expect(row.lastActorId).toBeNull();
  });

  it('never lists another tenant\'s queues', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/queues')
      .set('Authorization', `Bearer ${alpha.token}`)
      .expect(200);

    const ids = res.body.data.map((q: { id: string }) => q.id);
    expect(ids).toContain(alpha.queueId);
    expect(ids).not.toContain(beta.queueId);
  });

  it('rejects a token whose tid disagrees with the user row', async () => {
    // Hand-sign a token for alpha's user carrying BETA's tenant id.
    const forged = jwt.sign(
      { sub: alpha.userId, email: alpha.email, role: 'OWNER', tid: beta.tenantId },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );

    await request(app.getHttpServer())
      .get('/api/queues')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);                       // JwtStrategy's tid cross-check
  });

  it('does not leak another tenant\'s queue through the PUBLIC endpoint', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/public/tenants/${alpha.slug}/queues`)
      .expect(200);

    const ids = res.body.data.map((q: { id: string }) => q.id);
    expect(ids).not.toContain(beta.queueId);
  });

  it('cannot issue a token into another tenant\'s queue', async () => {
    await request(app.getHttpServer())
      .post(`/api/queues/${beta.queueId}/tokens`)
      .set('Authorization', `Bearer ${alpha.token}`)
      .send({ source: 'COUNTER' })
      .expect(404);
  });
});
```

Why this is a good test and a `findFirst`-vs-`findUnique` unit test is not:

- **It goes through the real HTTP layer**, so the guard, the strategy, the `@TenantId()`
  decorator and the service are all in the path. A unit test calling the service with a
  `tenantId` argument proves the service uses it, not that the controller passes the right
  one.
- **It asserts the database row is unchanged**, not only that the response was 404. A write
  that succeeded and then errored on the response would pass a status-only assertion.
- **The forged-token case exercises `JwtStrategy`'s `tid` cross-check**, which is the one
  defence that has no other test.
- **It fails loudly on the exact refactor that causes the bug.** Change `findFirst` to
  `findUnique` and case one turns from `404` into `200` with Beta's queue.

The suite seeds **three** tenants, not two, so a bug that scopes to "the first tenant"
rather than "the caller's tenant" shows up.

---

## 8. PII: what QueueLK stores about patients

### 8.1 The governing decision

> **A database of patient phone numbers at a medical clinic is the single worst thing in
> this system to leak.**

Everything below follows from that sentence.

### 8.2 Phone numbers are optional and never stored in plaintext

```prisma
/// OPTIONAL phone number, stored ONLY as a hash + last 4 digits.
///
/// v1 sends no SMS, so the plaintext number has no use — and a database of
/// patient phone numbers at a medical clinic is the single worst thing in this
/// system to leak. The hash supports "is this the same person as yesterday"
/// analytics and a future opt-in SMS lookup; the last 4 digits let staff read
/// "...4821" back to a patient at the counter. See docs/03-SECURITY.
phoneHash  String? @db.VarChar(64)
phoneLast4 String? @db.VarChar(4)
```

And the service signature enforces it:

```ts
export interface IssueTokenInput {
  ...
  /** Hash + last 4 only. The plaintext number never reaches this service. */
  phoneHash?: string;
  phoneLast4?: string;
  ...
}
```

The plaintext is hashed at the controller boundary and is never passed further in. That is a
type-level guarantee, not a convention: `TokensService` has no parameter that could hold a
phone number, so no future edit to it can accidentally persist one.

**Why hash at all rather than simply not collecting.** Two real uses:

1. **Repeat-visit analytics.** "38% of your patients this month also came last month" is a
   sentence that sells the product, and it needs an identity, not a number.
2. **A future opt-in SMS feature.** When SMS exists, a patient who types their number again
   can be matched to their prior tokens without QueueLK having stored anyone's number in the
   meantime.

**Why `last4` in the clear.** Staff genuinely need to read "...4821" back to a patient at the
counter to confirm they are talking to the right person. Four digits is a 1-in-10,000
identifier, useless for contacting anyone and sufficient for confirming.

**Honest limitation — the hash is not a strong protection.** Sri Lankan mobile numbers have
roughly 10⁷ possible values in practice (a handful of prefixes × 7 digits). An attacker
holding the database can brute-force the entire space in seconds. The hash is only
meaningful if it is **keyed** with a secret held outside the database, the way `deviceHash`
is:

```ts
hash(deviceId: string): string {
  return createHmac('sha256', this.secret).update(`device:${deviceId}`).digest('hex');
}
```

**The phone hash must use the same HMAC-with-secret construction, not a bare SHA-256.** With
a keyed HMAC, a database dump alone does not let anyone recover or confirm a number — the
attacker needs `DEVICE_COOKIE_SECRET` (or a dedicated `PHONE_HASH_SECRET`) as well, which
lives in `.env` on the server and not in the dump. This is called out here explicitly
because it is the difference between "we hash phone numbers" as a real control and as
theatre.

### 8.3 Patient names are optional

```prisma
/// Optional name, for the display's "Now serving A-014 — Nimal" courtesy line.
/// Optional because a queue that demands identity at the door stops being
/// faster than the paper slip it replaces.
patientName String? @db.VarChar(80)
```

The product reason and the privacy reason point the same way. A queue that demands identity
is slower than the paper it replaces, and a queue that does not collect names cannot leak
them.

What must be understood, and told to clinics: **a name entered here appears on the public
TV display** (§3.2). That is the feature. It is also a disclosure, and the settings page
should let a clinic turn the name off the display while still collecting it for the console.

### 8.4 `deviceHash` is a pseudonym, keyed

```prisma
/// Hash of the signed device cookie that took this token. Used to enforce
/// "one active token per device per queue" without storing anything that
/// identifies a person.
deviceHash String? @db.VarChar(64)
```

Keyed with the same secret as the cookie signature, so a leaked database alone does not let
anyone correlate rows back to a cookie value they hold — the join requires the secret too.

It still supports linkage *within* the database: rows sharing a `deviceHash` are the same
phone. So a dump reveals "this phone visited this clinic on these eleven days", which is a
visit pattern even without a name. Honest and bounded, but not nothing.

### 8.5 The `note` field

```prisma
/// Free note staff can attach: "wheelchair", "came with baby".
note String? @db.VarChar(200)
```

This is a free-text field on a medical clinic's records, entered by staff under time
pressure. **It will contain health information**, whatever the examples say. "Chest pain,
priority", "diabetic", "pregnant — 8 months".

There is no way to prevent that and no attempt to. What follows from it:

- `note` must be treated as the most sensitive column in the table, alongside `phoneHash`.
- It must never appear on a public surface. It does not: `QueueSnapshot`/`TokenSummary` do
  not carry it, only the console's `TokenView` does.
- It is a strong argument for field-level encryption at rest (§13) if QueueLK ever sells to
  a clinic that asks.
- Retention applies: `TOKEN_RETENTION_DAYS` (default 400) deletes it with the token row.

### 8.6 What is in the logs

The discipline in the code:

| Log site | What it records | Assessment |
|---|---|---|
| `AuthService.refresh` reuse warning | `userId` only | Fine |
| `AllExceptionsFilter` 5xx | Method, URL, stack | URLs contain `publicId` and `tokenId`. Acceptable; note that error logs therefore contain patient token handles |
| `AllExceptionsFilter` 4xx | Method, URL, and the message at `debug` | A validation error's message can echo a field value. Keep `debug` off in production |
| `RateLimitGuard` failure | The Redis error string | Fine |
| `IdempotencyService` replay | Endpoint and key | Fine — the key is client-generated and opaque |
| `QueuesService.broadcast` failure | `queueId` | Fine |

Prisma query logging must be **off in production**. With it on, every `issue()` prints the
SQL including `phoneHash` and `patientName` — turning the log aggregator into an
unencrypted, unaudited, indefinitely retained copy of patient data.

### 8.7 What a clinic must be told

This belongs in the product — a one-time modal on first setup — not only in a document
nobody reads:

> **Before you start**
>
> 1. The display page and the patient page are **public**. Anyone with the link can see
>    your queue numbers, waiting counts and how many patients you have served today.
> 2. If you enter patient names, they appear on the TV display. Turn this off in Settings
>    if your patients would not want it.
> 3. QueueLK does **not** store patient phone numbers. Only a one-way hash and the last
>    four digits are kept, so we cannot contact your patients and neither can anyone who
>    obtains our database.
> 4. Notes you attach to a token are stored for {TOKEN_RETENTION_DAYS} days and are visible
>    to every staff member at your location. Do not write anything there you would not want
>    a colleague to read.
> 5. Your data is never used to answer another clinic's queries and no QueueLK staff account
>    can read it.

Point 5 is true because of §7.5, and it is worth saying out loud precisely because most SaaS
products cannot say it.

---

## 9. JWT design

### 9.1 Two different secrets, and why

```ts
JWT_SECRET: Joi.string().min(32).custom(notAPlaceholder).required(),

JWT_REFRESH_SECRET: Joi.string()
  .min(32)
  .custom(notAPlaceholder)
  .required()
  .invalid(Joi.ref('JWT_SECRET'))
  .messages({
    'any.invalid':
      'JWT_REFRESH_SECRET must be a real random value and must differ from JWT_SECRET, so an access-token leak cannot mint refresh tokens',
  }),
```

Note `.invalid(Joi.ref('JWT_SECRET'))` — the schema **refuses to boot** if the two are equal.

The attack this prevents is specific. Access tokens and refresh tokens are both JWTs with
the same claim shape (`sub`, `email`, `role`, `tid`, plus `jti` on the refresh). If they
shared a secret:

1. An attacker obtains an access token — from a browser's network log, a proxy, an error
   report, a screenshot of DevTools, or any of the dozen places a 15-minute bearer token
   legitimately appears.
2. They present it to `POST /api/auth/refresh`.
3. `verifyRefreshSignature` checks the signature against `jwt.refreshSecret`. Same secret ⇒
   it verifies.
4. The 15-minute exposure is now a 7-day one.

Step 3 is the entire point. The lookup in `refreshToken` would still fail — the access token
was never stored there — so the practical exploit needs the secret to be leaked rather than
just a token. But separating the secrets means a *signature* forged for one purpose is
structurally invalid for the other, which is defence in depth that costs one extra
`openssl rand -hex 32`.

The third secret, `DEVICE_COOKIE_SECRET`, is separated for the mirror-image reason, stated
in the config:

```ts
/**
 * HMAC key for the patient device cookie.
 *
 * Separate from the JWT secrets on purpose. The device cookie is handed to
 * anonymous members of the public and is the weakest-guarded secret in the
 * system; if it is ever compromised, the blast radius must be "self-service
 * rate limits can be bypassed", not "staff sessions can be forged".
 */
```

Three secrets, three blast radii, ordered by how exposed each is.

### 9.2 Minimum 32 characters

```ts
// 32 chars minimum: a short HMAC secret is brute-forceable offline once an
// attacker holds a single signed token.
```

HS256 is HMAC-SHA256. Anyone holding one signed token can test candidate secrets offline at
GPU speed, with no rate limit and no network. A 12-character secret falls in hours; the
published `jwt-cracker` tooling exists for exactly this. 32 characters of hex from
`openssl rand -hex 32` is 128 bits of entropy — not brute-forceable.

### 9.3 Claims are minimal, and a JWT is not encrypted

```ts
const payload: JwtPayload = {
  sub: user.id,
  email: user.email,
  role: user.role,
  tid: user.tenantId,
};
```

**A JWT is signed, not encrypted.** Anyone holding it can base64-decode the payload. The
`email` claim is a conscious small compromise — convenient for logging, and the user already
knows their own email — but no name, no clinic name, and nothing a patient would consider
confidential goes in. Putting personal data in a JWT means putting it in every browser's
network log and every proxy that sees the header.

`role` is *in* the token but is **not used** from it — `JwtStrategy` returns the role from
the database row. The claim is there for debugging and for a future stateless fast path; the
authoritative value is the row.

### 9.4 The `jti`

```ts
// A random jti makes every refresh token unique even when issued to the same
// user in the same second — without it two tokens could collide on the
// tokenHash unique index.
const jti = randomBytes(32).toString('hex');
```

Two JWTs signed for the same user with the same `iat` (same second) would be byte-identical,
therefore SHA-256-identical, therefore a unique-constraint violation on `tokenHash`. The
`jti` also gives each refresh token 256 bits of CSPRNG entropy, which is what makes SHA-256
the right hash for it (§4.2).

---

## 10. Passwords

### 10.1 bcrypt, cost 12

```ts
/**
 * bcrypt cost 12. Each +1 doubles the work. 12 lands around ~250ms on typical
 * server hardware: slow enough that offline brute force of a leaked hash is
 * expensive, fast enough not to become a login DoS vector itself.
 */
private static readonly BCRYPT_ROUNDS = 12;
```

**Why not SHA-256 or MD5.** They are designed to be fast, which is precisely wrong for
password hashing. A commodity GPU computes billions of SHA-256 hashes per second, so a
leaked table of SHA-256 password hashes is effectively a leaked table of passwords for
anything short of a long random string. MD5 additionally has practical collision attacks and
has been unfit for security use for two decades.

**Why bcrypt.** Deliberately slow and memory-touching, so GPUs gain far less advantage.
Salts automatically with the salt embedded in the output, so identical passwords produce
different hashes and rainbow tables are useless. Tunable cost, so it can be raised as
hardware improves.

**Why 12 specifically.** Each +1 doubles the work. Cost 12 lands around 250–350 ms on
typical server hardware: unnoticeable on a login that happens once a morning, brutal for an
attacker (a few hundred guesses per second per core instead of billions). Cost 10 is the
common default and is now on the low side. Cost 14 (~1 s) makes login feel broken on a cheap
tablet and turns `/api/auth/login` into a self-DoS vector — remembering that the timing-safe
branch in §10.3 runs a full bcrypt hash for *failed* logins too, so the cost is paid on
attacker traffic as well.

**Why not argon2id.** It is the current recommendation and its memory-hardness resists GPU
and ASIC attacks better. bcrypt at 12 is chosen for maturity and a zero-friction Node
install story — `bcrypt` is already a native dependency that has to build, and adding a
second one is real friction on a Windows development machine. argon2id is a clean upgrade
path and is the right choice for a greenfield system with an ops team.

### 10.2 Policy per NIST 800-63B

```ts
/**
 * Password policy: 8+ characters with at least one letter and one digit.
 *
 * Deliberately not the classic "uppercase + symbol + digit" rule. NIST 800-63B
 * dropped composition rules because they push users toward Password1! patterns
 * that are easy to guess and hard to remember. Length is what actually helps —
 * and for a clinic receptionist who will type this on a tablet every morning,
 * a rule they can satisfy without writing it on a sticky note is a security
 * feature, not a compromise.
 */
const PASSWORD_PATTERN = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/;
```

The sticky-note argument is the operative one. A composition rule that a receptionist cannot
satisfy from memory produces a password written on paper and taped under the counter — next
to the tablet, in a room the public walks through. The rule is deliberately weak enough to
be memorable and is backed by rate limiting (10 attempts / 15 min / IP) rather than by
complexity theatre.

**`@MaxLength(72)` is not cosmetic:**

```ts
@MaxLength(72) // bcrypt silently truncates beyond 72 bytes; reject instead.
password!: string;
```

bcrypt truncates input beyond 72 **bytes** without any error, so a 100-character passphrase
would have its last 28 characters silently ignored. Rejecting is honest; truncating silently
is a trap — and it is worse than it sounds for a bilingual product, because a Sinhala
passphrase in UTF-8 uses 3 bytes per character, so 24 Sinhala characters already reaches the
limit.

### 10.3 User-enumeration defence on login

```ts
if (candidates.length === 0) {
  // Hash against the supplied password anyway so a missing account and a
  // wrong password take the same time — otherwise response latency reveals
  // which emails are registered (user enumeration).
  await bcrypt.hash(dto.password, AuthService.BCRYPT_ROUNDS);
  throw new UnauthorizedException('Invalid credentials');
}
```

Without that dummy hash, "unknown email" returns in ~5 ms while "wrong password" takes
~250 ms — a 50× difference, trivially measurable over the internet even with jitter. That
turns `/api/auth/login` into an oracle: feed a breach corpus of email addresses and learn
which ones have QueueLK accounts, then target only those with credential stuffing.

Also enforced: **identical messages** for both failure modes (`'Invalid credentials'`) and
identical HTTP status. Timing is not the only side channel, and a different message is a far
easier one to read.

`bcrypt.compare` is itself constant-time with respect to the hash contents, so a correct
password prefix does not return faster than an incorrect one.

**Where enumeration is still possible, stated honestly.** The multi-tenant login path leaks
one bit:

```ts
if (candidates.length > 1) {
  throw new UnauthorizedException(
    'This email is registered at more than one location. Please include your location.',
  );
}
```

That message confirms the email is registered at ≥2 locations. It is a genuine leak and it
is accepted, because the alternative — failing with 'Invalid credentials' — leaves the nurse
who works at two clinics unable to log in with no way to discover why. A product that cannot
be logged into is worse than one that confirms an email exists. Note the leak only fires for
the multi-tenant case, which is rare, and registration's 409 already leaks organisation
names (§5.2).

**`isActive: true` is in the login query**, so a deactivated user takes the same
zero-candidates path as an unknown one. A deactivated staff member cannot distinguish
"disabled" from "wrong password", which is correct — they should be told by their manager,
not by the login form.

### 10.4 Role is never taken from the request body

```ts
return tx.user.create({
  data: {
    tenantId: tenant.id,
    email,
    passwordHash,
    name: dto.name.trim(),
    // The person who creates the location owns it. Role is never taken from
    // the request body — that would be one field away from privilege
    // escalation.
    role: Role.OWNER,
  },
});
```

A `role` field accepted from a registration payload is one `whitelist: false` away from
self-service OWNER. It is assigned by the server, full stop.

Tenant and OWNER are created in **one transaction**. A tenant with no user is unreachable —
nobody can log in to it — and would sit in the database as permanent garbage holding a
unique slug hostage.

---

## 11. Cookies

### 11.1 The refresh cookie

```ts
private cookieOptions(): CookieOptions {
  const isProduction = this.config.get<string>('nodeEnv') === 'production';
  const domain = this.config.get<string>('cookieDomain');

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/api/auth',
    ...(domain ? { domain } : {}),
  };
}
```

| Flag | Value | The attack it addresses |
|---|---|---|
| `httpOnly` | `true` | XSS exfiltration. A successful script injection can act as the user while the page is open, but cannot *walk away* with 7 days of access |
| `secure` | `isProduction` | Network interception. Conditional because a `Secure` cookie is dropped over plain `http://localhost`, which would silently break local development with a confusing "login does nothing" symptom |
| `sameSite` | `'lax'` | CSRF on the refresh endpoint |
| `path` | `'/api/auth'` | Scope. The cookie is not attached to the hundreds of ordinary console requests in a session — only the endpoints that legitimately need it ever see it |
| `domain` | from `COOKIE_DOMAIN` | Subdomain sharing when the console and API are on different subdomains. Empty means host-only, which is tighter |

And from the controller:

```ts
/**
 * Why not return it in JSON for the client to store: anything JavaScript can
 * read, an XSS payload can exfiltrate. httpOnly means a successful script
 * injection still cannot steal the long-lived credential — it can act as the
 * user while the page is open, which is bad, but it cannot walk away with 7
 * days of access to a clinic's queue.
 *
 * The short-lived access token DOES go to JS (held in memory, never
 * localStorage) because the Authorization header is what makes CSRF a
 * non-issue for the API.
 */
```

That last clause is the reason CSRF tokens are absent: every state-changing API call
authenticates with a `Authorization: Bearer` header, which a cross-site form post cannot
set. The only cookie-authenticated endpoint in the system is `POST /api/auth/refresh`, and
that one is covered by `sameSite: 'lax'`.

### 11.2 Why `lax` and not `strict` — the QR-code argument

This is the decision most worth explaining, because `strict` looks stricter and is wrong
here for a product-specific reason.

**For the device cookie** the argument is decisive, and the code states it:

```ts
/**
 * 'lax', not 'strict'. The patient arrives by scanning a QR code, which is
 * a top-level navigation from outside the site; 'strict' would withhold
 * the cookie on exactly that first request and mint a new device every
 * single scan, defeating the point.
 */
sameSite: 'lax',
```

Walk through it. A patient scans the poster. The phone's camera app opens
`https://queuelk.lk/q/sunrise-dispensary/A` — a top-level navigation whose *initiator* is
the camera app, not queuelk.lk. Under `SameSite=Strict` the browser withholds the cookie on
that navigation. So:

1. Every scan looks like a brand-new device.
2. `DeviceMiddleware` mints a fresh device id on every single scan.
3. The one-active-token-per-device rule (§2.2, layer 3) never matches anything.
4. The per-device rate limit never matches anything.
5. A patient returning to their token page can no longer cancel, because the
   `deviceHash` on their token belongs to a device identity they no longer present (§5.4).

`SameSite=Strict` would silently delete two of the four anti-abuse layers and break the
cancel button — and every one of those failures is invisible in local testing, because in
development you type the URL rather than scanning it.

**For the refresh cookie** the argument is the same shape and slightly weaker but still
correct:

```ts
/**
 * 'lax' not 'strict': 'strict' would drop the cookie on a top-level
 * navigation back from an external link, logging staff out for no reason.
 * 'lax' still blocks the cross-site POST that CSRF needs, and the refresh
 * endpoint is the only thing this cookie authorises.
 */
```

Staff reach the console from a bookmark, a WhatsApp message from the owner, or a link in an
email. Under `Strict`, arriving from any of those means the cookie is withheld on the first
request and the console shows a login screen for someone who is logged in. They log in
again, it works, and they conclude the product logs them out at random.

**What `lax` still gives you.** `SameSite=Lax` sends the cookie on top-level GET navigations
and withholds it on cross-site POST, PUT, DELETE and all subresource requests
(`<img>`, `fetch`, `<iframe>`). CSRF requires a cross-site state-changing request — which is
exactly the category `Lax` blocks. `POST /api/auth/refresh` from evil.lk gets no cookie.

**`SameSite=None` is never needed anywhere**, because nothing in QueueLK is embedded
cross-site. No widget, no iframe. That is worth preserving: `None` requires `Secure` and
removes the CSRF protection entirely, and once one cookie needs it there is pressure to make
them all consistent.

### 11.3 A tampered device cookie is "no device", not an error

```ts
/**
 * Returns the raw device id if the cookie is authentic, otherwise null.
 *
 * A tampered or unsigned cookie is treated as "no device" rather than as an
 * error: the caller then issues a fresh one. Rejecting the request would let
 * anyone break a patient's page by planting a junk cookie.
 */
```

The rejected alternative is a 400 on a bad signature. That sounds more secure and is worse:
an attacker who can set a cookie on `queuelk.lk` (a subdomain takeover, a shared-host XSS)
could then plant a junk value and make the patient page 400 for that visitor permanently.
Treating it as absent is strictly safer and the failure mode is "you get a new pseudonym",
which is already what an attacker can achieve by clearing cookies.

---

## 12. Platform hardening

### 12.1 helmet and the CORS allowlist

`helmet` sets the standard response headers: `X-Content-Type-Options: nosniff`,
`Referrer-Policy`, `X-DNS-Prefetch-Control`, `X-Frame-Options`, and HSTS in production.
None of them is exotic; the value is that they are all set by default rather than
individually remembered.

CORS is an **allowlist**, from configuration, never `*`:

```ts
corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3001')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean),
```

`*` cannot be used even if someone wanted to, because the console sends credentials and
browsers refuse `Access-Control-Allow-Origin: *` together with
`Access-Control-Allow-Credentials: true`. That browser rule is doing real work here.

What CORS does **not** do, and must not be relied on: it is a browser policy. It does not
stop `curl`, a script, or any non-browser client from calling the public endpoints. The
public endpoints are public (§3); CORS protects the *console* from a malicious page in a
staff member's other tab, and nothing else.

### 12.2 Joi refuses placeholder secrets at boot

```ts
const PLACEHOLDER_SECRETS = [
  'change_me',
  'changeme',
  'replace_me',
  'dev_access_secret_change_me_to_something_random_32',
  'dev_refresh_secret_change_me_to_something_random',
  'dev_device_secret_change_me_to_something_random',
];

const notAPlaceholder: Joi.CustomValidator<string> = (value, helpers) => {
  const lowered = value.toLowerCase();
  if (PLACEHOLDER_SECRETS.some((p) => lowered.includes(p))) {
    return helpers.error('any.invalid');
  }
  return value;
};
```

From the file's own comment:

> Validating "is this long enough" is not sufficient: the most common self-hosting incident
> is copying `.env.example` to `.env`, filling in the database URL, and leaving the
> placeholder secrets. This check turns that into a boot failure with a readable message
> instead of a silently forgeable JWT.

The placeholders in `.env.example` are deliberately **32+ characters long**, so a
length-only check would pass them. The `includes` test catches them by content. And the
error message tells you the fix:

```
JWT_SECRET is still the .env.example placeholder. Generate one: openssl rand -hex 32
```

The whole schema runs at bootstrap, so a bad value is a crash with a readable message rather
than a mysterious 500 on the first request that happens to need it.

### 12.3 Validation: whitelist and forbidNonWhitelisted

```ts
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
);
```

| Option | Effect | Why |
|---|---|---|
| `whitelist: true` | Strips properties with no validation decorator | A body field nobody declared cannot reach a service or a Prisma `data` object |
| `forbidNonWhitelisted: true` | **400s** instead of stripping | Silent stripping hides an attack in progress *and* hides a client bug. `{"role": "OWNER"}` should be a loud error, not a shrug |
| `transform: true` | Instantiates the DTO class | Without it the handler receives a plain object and `@Type` coercion does not run, so a numeric field arrives as a string and comparisons quietly misbehave |

Combined with `@MaxLength` on every string DTO field, this is also the length bound that
keeps a 10 MB `patientName` from reaching Postgres.

### 12.4 Prisma error masking

```ts
default:
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: 'InternalServerError',
    message: 'A database error occurred',
  };
```

Raw Prisma errors carry table names, column names and sometimes values. That is free
reconnaissance: an attacker probing endpoints learns the schema from error messages. The
filter maps known codes to safe messages and everything else to a generic one, with the
real reason in the logs.

One mapping is deliberately *not* generic:

```ts
if (target?.includes('number')) {
  return {
    status: HttpStatus.CONFLICT,
    error: 'Conflict',
    message: 'Token number collision — please retry',
  };
}
```

That unique violation is the `(queueId, serviceDate, number)` backstop. If it ever fires
there is a genuine bug in the counter path, so it gets a distinct, loud message rather than
being buried under "already exists". A constraint that has never fired is not wasted — it is
the reason the failure mode is a 409 instead of two patients at one counter.

The filter also handles SSE correctly:

```ts
if (response.headersSent) {
  response.end();
  return;
}
```

An SSE stream may already have sent headers and events. Writing a JSON error on top would
corrupt the stream; closing it lets `EventSource` reconnect with backoff, which is the
desired behaviour.

### 12.5 Idempotency as a safety control

`IdempotencyService` is usually filed under reliability, but it belongs here too: it is the
control that makes replay harmless.

```
- First request with a given (tenant, key): the action runs, the response is
  stored, and it is returned.
- Retry with the SAME key and the SAME body: the stored response is returned
  verbatim, and the action does NOT run again.
- Same key with a DIFFERENT body or endpoint: 409.
```

Two security-relevant properties:

**Keyed by `(tenantId, key)`**, so one tenant's client cannot collide with — or probe for —
another's keys. A globally-keyed idempotency table would be a cross-tenant oracle: send a
guessed key, and a 409 tells you someone else used it.

**The record is written inside the same transaction as the action**, which is why it is in
Postgres and not Redis:

> If Redis loses the key after a restart, a retry re-executes "Call next" and the thing we
> built this to prevent happens anyway. The idempotency row is written in the SAME
> transaction as the state change, so they commit or roll back together — that atomicity is
> the whole design and Redis cannot participate in a Postgres transaction.

The `409 on a different body` rule matters: returning the first response for a different
request would report success for an action that never happened. That is worse than an error.

### 12.6 Fail-closed authentication

```ts
/**
 * Registered globally in AppModule, so routes are authenticated by DEFAULT and
 * must opt out with @Public(). Fail-closed: forgetting a decorator leaves an
 * endpoint locked rather than silently exposing one clinic's patient queue to
 * the whole internet.
 */
```

The rejected alternative is per-controller `@UseGuards(JwtAuthGuard)`. Under that model a
new controller added in a hurry is public by default, and nothing tells you. Under this
model a forgotten decorator produces a 401 that someone notices in ten seconds.

The corollary: every `@Public()` in the codebase is a security decision and should be
reviewed as one. There should be a short, countable list of them, all on `/api/public/*` and
`/api/auth/*`.

---

## 13. Not implemented in v1

Deliberate omissions, the honest reason, and what would trigger building each.

| Not implemented | Honest reason | What would trigger it |
|---|---|---|
| **Two-factor authentication** | Every staff login happens on a shared clinic tablet with no personal phone attached to it. TOTP on a device three people share is a shared secret, not a second factor — and the recovery flow (staff locked out at 07:00 with patients waiting) is worse than the threat | A clinic chain with per-person devices, or the first account takeover |
| **SMS phone verification** | Costs money per message, needs a Sri Lankan gateway contract, and would make taking a token slower than the paper slip it replaces | The SMS notification feature ships (it needs a gateway anyway), or repeated targeted queue-stuffing at one clinic |
| **CAPTCHA on self-service** | It would stop a 70-year-old patient at the door. The layered limits in §2 bound the damage without excluding anyone | Sustained automated abuse at a specific clinic that §2.5's operational answers cannot handle |
| **Field-level encryption at rest** (`note`, `patientName`, `phoneHash`) | Application-level encryption means those columns can no longer be searched or indexed, and the key has to live somewhere on the same box — which protects against a stolen disk and not against a compromised app | A clinic that asks for it contractually, or handling anything that is clearly a medical record rather than a queue position |
| **A keyed HMAC for `phoneHash`** (as opposed to a plain hash) | **This one is a gap, not a trade-off.** §8.2 explains why a bare SHA-256 of a Sri Lankan mobile number is brute-forceable in seconds | It should be done before the first real clinic stores phone numbers. Highest-priority item in this table |
| **An audit log viewer** | The table exists and is written correctly; there is no UI. An audit log with no reader deters nobody | The first dispute a clinic asks you to settle. Half a day of work, high value (§6.4) |
| **Alerting on staff creation / role change** | No email infrastructure in v1 | Before selling to any clinic with more than two staff. This is the fix for §4.5's worst case |
| **WAF** | A VPS with Caddy has no WAF. Cloudflare's free tier would provide one | Any sustained attack traffic, or the first clinic that asks about DDoS |
| **Rate limiting that survives Redis** | Deliberate: fails open so a Redis outage cannot take a clinic offline. The hard limits are in Postgres (§2.2) | Only if the Postgres-side limits prove insufficient, which would mean §2 was wrong |
| **Penetration test** | Costs more than the product's first year of revenue | An enterprise or government customer. A government counter deployment would require one |
| **SOC 2 / ISO 27001** | Six figures and a full-time compliance role, for a product sold at Rs 3,000/month | Not applicable at this scale. Would be a different business |
| **Per-tenant database** | Isolation by `WHERE tenantId` in one database is what makes 50 clinics fit on one Rs 2,000/month VPS. Per-tenant databases mean per-tenant migrations, per-tenant connections, and a different price point | A customer with a regulatory requirement for physical separation |
| **CSP with nonces** | The Next.js app would need a nonce plumbed through every inline script and style. Real work for a surface with no user-generated HTML — nothing in QueueLK renders untrusted markup | Any feature that renders user-supplied rich content, or the first XSS report |
| **Subresource Integrity** | No third-party scripts are loaded | The first CDN dependency |
| **Automated dependency scanning beyond `npm audit`** | `npm audit` in CI is the whole budget | A Dependabot-shaped incident |
| **Idle session timeout** | A counter tablet that logs staff out mid-morning is a tablet staff leave logged in by writing the password on it (§10.2) | Per-person devices, alongside 2FA |
| **`REVOKE DELETE` on `audit_events`** | Append-only is a code property, not a database grant | Trivial to add, and should be, at the same time as the audit viewer |
| **Backup encryption enforced by the product** | It is documented in the deployment guide in the private repo and is the operator’s responsibility | A managed/hosted tier where QueueLK runs the backups |
| **Turning off `patientName` on the display** | The setting does not exist; names are shown if entered | The first clinic that asks. One boolean on `Tenant.features`, which is exactly what that JSON column is for |
| ~~**Splitting the public snapshot from the console snapshot**~~ | — | **No longer outstanding: implemented.** `PublicService.toPublicQueue()` drops `servedToday` and `averageServiceSeconds` at the edge, with tests in both directions. See §3.5 |

### 13.1 The three to build first

If only three of these are ever built, they should be these, in this order:

1. **Keyed HMAC for `phoneHash`.** It is a gap, not a trade-off, and it concerns the most
   sensitive column in the database.
2. **Email alert on staff creation and role change.** It closes the only *persistent*
   compromise path in the threat model (§4.5).
3. **The audit log viewer.** It converts an unread table into the actual answer to §6.

Everything else in that table is a defensible trade-off for a product at this size. Those
three are not.
