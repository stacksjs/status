---
title: Scaling & multi-region
description: Scale UptimeStatus workers horizontally and add geographic check regions with the push-probe consensus model.
---

# Scaling & multi-region

A single UptimeStatus box handles a real monitoring workload, but two things eventually push you past it: **volume** (too many checks for one worker) and **false positives** (one probe location can't tell a real outage from its own lost route). This page covers both.

## Queue scaling

Check jobs are the dominant workload — N monitors on a 60-second interval means at least N jobs per minute, before more expensive jobs like SSL scans are counted. The queue driver you choose (`QUEUE_DRIVER`) decides how far you can scale:

- **`sync`** — runs inline, no real queue. Development only.
- **`database`** — durable and infrastructure-free, but polling-based. Fine at low-to-moderate monitor counts.
- **`redis`** — recommended for any real deployment. Distributed locking and rate limiting let multiple worker processes pull from the same queue safely.

Once on Redis, scale **horizontally** by running more worker *processes* — more hosts, or more processes per host — all pointed at the same `REDIS_URL`. Run separate pools for the `checks` and `notifications` queues so a burst of outbound alerts never delays the next round of checks:

```bash
buddy queue:work --queue=checks
buddy queue:work --queue=notifications
```

Watch queue depth with `buddy queue:status`; sustained growth (jobs enqueued faster than they drain) is the signal to add workers.

## Multi-region checks: the push-probe model

Adding a second geographic region is what turns single-probe blips into reliable alerting. The production model is **push-probe**, which needs no shared or networked database:

```
  Region worker box (e.g. us-east)          Primary (eu-central)
  ┌───────────────────────────┐             ┌──────────────────────────┐
  │ pulls the list of monitors │  GET  ────▶ │ /api/regions/…/monitors  │
  │ runs uptime/ping/tcp/health│             │                          │
  │ checks from its region     │  POST ────▶ │ /api/regions/…/results   │
  │                            │  results    │   writes region-tagged   │
  └───────────────────────────┘             │   CheckResult rows        │
                                            │ consensus job folds votes │
                                            └──────────────────────────┘
```

A regional worker box pulls check jobs, runs them from its location, and posts back **CheckResults tagged with its region**. The primary keeps running its own checks tagged with its region, then a consensus job folds every region's observations into a single verdict: an incident opens only when at least `CONSENSUS_MIN_REGIONS` regions agree a monitor is down. A stale region (one that's gone silent) is dropped by the freshness window, so a real outage still alerts. A single-region install clamps the threshold to 1 and behaves exactly as before — nothing to configure until you actually add a region.

## Adding a region (high level)

1. Provision a small worker box in the new location.
2. Give it the probe token, the primary's URL, and a distinct region label (e.g. `WORKER_REGION=us-west`). Region secrets are supplied per box — never hard-coded.
3. Append the new label to `MONITOR_REGIONS` on the primary.

No code change is required — the consensus job and ingest endpoints are region-agnostic. Every added region proportionally increases outbound check traffic against every target, so start with two and add a third only when you have a concrete reason.
