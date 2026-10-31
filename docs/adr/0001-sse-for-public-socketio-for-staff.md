# ADR 0001 — SSE for the public screens, Socket.io for the staff console

- **Status:** Accepted
- **Date:** 2026-10-30
- **Phase:** UPGRADE-PLAN 1.1
- **Supersedes:** the "WebSockets instead of SSE — rejected" entry in
  [01-ARCHITECTURE §7](../01-ARCHITECTURE.md#7-trade-offs-consciously-rejected), for the staff
  console only

## Context

QueueLK has four live surfaces, and they do not have the same traffic shape:

| Surface | Who | Direction | Auth | Count per clinic | Hardware |
|---|---|---|---|---|---|
| TV display `/d/[slug]` | Nobody, it is on a wall | Server → client only | None (public) | 1–3 | Cheap Android TV stick |
| Patient phone `/t/[publicId]` | A patient | Server → client only | None (the publicId is the credential) | Dozens per day | Any phone, often on mobile data |
| Staff console `/console` | Receptionist | **Both ways**: a command every few seconds, and every other tablet's changes back | JWT (OWNER / STAFF) | 1–4 tablets | Tablet or phone on clinic Wi-Fi |
| Owner dashboard | Owner | Mostly reads | JWT | 1 | Desktop |

v1 used Server-Sent Events everywhere, and every staff action was a REST `POST`. The
architecture document argued that WebSockets were "the fashionable answer, and the wrong
one here" — correctly for the TV and the phone. But that argument rested on one claim:
*"the traffic is one-directional"*. For the console it is not:

1. **A command needs an answer, and the answer is the point.** "Call next" is not
   fire-and-forget. The receptionist needs to know *which* patient was called, and when
   two tablets press it together each needs its own answer. Over REST that is fine; over
   SSE it is impossible. A transport where the console sends commands and receives state
   on the same connection lets the server acknowledge each command and push the resulting
   state to the other tablets in one place.
2. **The console was not live at all.** It polled `/queues/live` every 5 seconds and the
   token list every 8. A change made on tablet A appeared on tablet B up to 8 seconds
   later — long enough for B to call a patient A had just marked a no-show.
3. **The console is authenticated, the public screens are not.** The things that made
   WebSockets awkward for the public pages (no cookies on the upgrade, tokens in query
   strings, a second auth path) are things the console already has to solve for REST.

## Options considered

### A. Keep SSE everywhere; add an authenticated SSE stream for the console

Commands stay REST, state comes back over a JWT-protected `EventSource`.

- + One realtime protocol. No new dependency.
- − `EventSource` cannot send an `Authorization` header. The token would go in the query
  string (and so into proxy logs) or into a cookie (and so the console would need CSRF
  protection it does not have today).
- − Still two channels per command — a `POST` out and an SSE event back — with nothing
  tying the event to the command that caused it.

### B. Socket.io for everything, public pages included

- + One protocol for every surface.
- − Throws away what is genuinely better about SSE for the public pages: plain HTTP
  through any proxy, `EventSource`'s built-in reconnect, `curl`-debuggable, and the
  lightest possible client on a 2016 Android TV.
- − Puts a stateful connection registry in front of the anonymous, highest-volume
  surface (dozens of phones per clinic), where the payoff — client-to-server messages —
  is zero.

### C. Raw WebSockets (`ws`) for the console

- + No library on the client.
- − Reconnection, acknowledgements with timeouts, rooms, and multi-instance fan-out
  would all be hand-written. Socket.io is those four things, already debugged.

### D. Socket.io for the staff console only; SSE stays for public screens — **chosen**

## Decision

**Option D.**

- **Public surfaces (TV display, patient phone) stay on SSE** over Redis pub/sub, unchanged.
  They are one-way, anonymous and cheap, which is exactly what SSE is for.
- **The staff console uses Socket.io**, namespace `/staff`:
  - **Auth** — the access JWT goes in the handshake `auth` payload (never the query string)
    and is checked by a namespace middleware with the *same* code as an HTTP request:
    signature and expiry, then `JwtStrategy.validate` (user exists, is active, tenant
    matches), then a role gate (OWNER or STAFF). The socket is closed when the token
    expires, and every command re-validates the user, so deactivating a stolen tablet takes
    effect on an open socket immediately.
  - **Rooms** — `tenant:{tenantId}:queue:{queueId}`, joined only after the queue has been
    loaded with the socket's *own* tenant id in the `WHERE` clause.
  - **Commands with acknowledgements** — `call_next`, `recall`, `skip`, `no_show`, `done`.
    Each acks `{ ok: true, data: <TokenView | null> }` or
    `{ ok: false, error: { code, message, status } }` with the same codes REST returns.
  - **Broadcast** — `queue_state` (the full staff snapshot) to the room after **every**
    committed change, whatever caused it: a socket command, a REST call, the patient
    cancelling on their phone, the owner pausing the queue. It is emitted from
    `QueuesService.broadcast`, the same place the SSE event is published.
  - **Scale-out** — `@socket.io/redis-adapter` over the same Redis, so a `queue_state`
    emitted on instance A reaches a tablet connected to instance B. (Proved by an
    integration test that boots two API instances.)
- **No business logic in the gateway.** It calls the same `TokensService` methods as the
  REST controller, with the same idempotency semantics. A command that times out on the
  socket is re-sent over REST **with the same idempotency key**, and the server replays
  the first result rather than calling a second patient.
- **REST stays** as the console's fallback, and remains the API for every other client.

## Consequences

**Good**

- A tablet sees another tablet's "Call next" in well under a second instead of up to 8
  seconds later; the console's poll relaxes from 5 s to 30 s while the socket is up.
- Each command gets a typed, per-command answer, which made keyboard shortcuts (N, R, S)
  and "disable the buttons until acknowledged" straightforward.
- The console shows **Live / Reconnecting / Offline**, so staff know when they are looking
  at a possibly stale queue — the same honesty rule the TV display already follows.

**Costs, accepted**

- **Two realtime protocols** to understand, test and operate. Mitigated by keeping both
  thin and by both fanning out through the same Redis.
- **A new dependency** (`socket.io`, `@socket.io/redis-adapter`, `socket.io-client`) and
  ~15 KB gzipped on the console bundle only — the public pages do not load it.
- **Sticky sessions matter.** Socket.io's HTTP long-polling fallback needs every request
  of one session to reach the same instance. WebSocket-only clients do not, but behind a
  proxy that strips upgrades the client falls back to polling. Any load balancer in front
  of more than one API instance needs session affinity; on Cloud Run that is the
  `sessionAffinity` setting plus a request timeout long enough for the socket (Phase 4.3).
- **Socket.io is not in the OpenAPI document.** The event contract lives in
  `apps/api/src/staff-realtime/staff.gateway.ts` and is covered by
  `apps/api/test/staff-gateway.e2e-spec.ts`.

**Neutral**

- The idempotency record keys on the service-level endpoint, not the transport, so a key
  used on the socket and replayed over REST is one action. This was already true of the
  design; the socket made it load-bearing.

## Revisit when

- A **mobile app** (Phase 2) needs live updates: it is authenticated-less like the phone
  page, so SSE remains the default; switch only if it needs to send.
- **Connection counts** grow past what one Node process per instance handles comfortably
  (thousands of displays) — then the Go fan-out service noted in 01-ARCHITECTURE §7 is
  the answer for SSE, and Socket.io's adapter would move to Redis Streams or a sharded
  adapter.
