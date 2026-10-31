# ADR 0005 — Upstash Redis instead of Memorystore on GCP

- **Status:** Accepted
- **Date:** 2026-10-30
- **Phase:** UPGRADE-PLAN 4.1

## Context

QueueLK uses Redis for three things, none of them a system of record: SSE
pub/sub fan-out between API instances, the Socket.io Redis adapter, and
rate-limit windows plus a slug cache. Token numbers live in Postgres, so losing
Redis loses nothing that matters (docker-compose.yml runs it with no
persistence on purpose).

On GCP the natural choice is Memorystore for Redis. The owner has no budget.

## Options

| | Memorystore (Basic, 1 GB) | Upstash Redis (free tier) | Redis on a VM |
|---|---|---|---|
| Cost | roughly USD 35+/month, always on | free tier (daily command cap) | e2-micro is free-tier eligible in some US regions only |
| Network | private IP in the VPC | public endpoint over TLS (`rediss://`) | VPC |
| Ops | managed | managed | patching, restarts, yours |
| Pub/Sub, adapter | yes | yes (Upstash supports pub/sub over TCP) | yes |
| Latency from asia-south1 | same region | pick the Mumbai region at Upstash | same region |

## Decision

Use **Upstash Redis** (Mumbai region) for the lab. Its URL is stored in Secret
Manager as `redis-url`, added by hand, so Terraform holds no Upstash
credentials. The API is unchanged: it already reads `REDIS_URL` and accepts
`rediss://`.

## Consequences

- Traffic to Redis leaves the VPC over TLS. It carries queue snapshots and
  rate-limit counters, never patient names (public payloads do not include
  them).
- The free tier caps daily commands. A busy demo (the k6 morning rush) can hit
  it; that is fine for a lab and a reason to move later.
- Moving to Memorystore later is a Terraform change (`google_redis_instance`)
  plus a new secret value: no code change. That is the trigger to switch: a
  paying clinic, or the free tier's limits.
