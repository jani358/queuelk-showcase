# ADR 0006 — Cloud Run instead of GKE

- **Status:** Accepted
- **Date:** 2026-10-30
- **Phase:** UPGRADE-PLAN 4.1–4.3

## Context

QueueLK is two stateless containers (API, web), a migration step, Postgres and
Redis. It needs WebSockets (staff console) and long-lived SSE (TV displays,
patient phones). Traffic is spiky: a morning rush, then quiet, and nothing at
night.

## Decision

Run the API and web app on **Cloud Run** services and migrations as a
**Cloud Run job**. Do not use GKE.

## Why

| | Cloud Run | GKE Autopilot | GKE Standard |
|---|---|---|---|
| Idle cost | zero (scales to zero) | pods billed while running; no free cluster fee credit beyond one zonal cluster | node VMs always on |
| Ops | none: no nodes, no upgrades | Google runs nodes; you own manifests, ingress, HPA | you own nodes too |
| WebSockets / SSE | yes, capped at 60 min per request | no cap | no cap |
| Sticky sessions | cookie affinity, best effort | ingress/BackendConfig affinity | same |
| Deploy | `gcloud run deploy` with an image | kubectl / Helm / Argo | same |

The 60-minute connection cap is the real cost, and the clients already
reconnect (docs/04-DEPLOYMENT.md §13.1). Everything else favours Cloud Run
for a small product and a lab with no budget.

## When to revisit

- Many always-connected displays per clinic, so instances never scale down
  and Cloud Run's per-request pricing loses to a node pool.
- A need for things Cloud Run cannot do: sidecars beyond its limits, DaemonSets,
  custom networking.
- A team already running Kubernetes for other services. (The BookLK project
  covers the Kubernetes story separately.)
