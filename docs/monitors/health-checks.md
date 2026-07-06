---
title: Health Checks
description: Fetch a JSON health endpoint and alert on degraded fields with per-field assertions.
---

# Health Checks

A health check goes deeper than "did the page load." It fetches a structured JSON endpoint your app exposes and inspects individual fields — so you can alert when the database connection is degraded, a queue is backing up, or a dependency is unreachable, even while the front page still returns `200`.

## How it works

On each run the checker requests your health URL, parses the response as JSON, and evaluates your **field assertions** against it. A typical endpoint looks like:

```json
{
  "status": "ok",
  "version": "2.4.1",
  "checks": {
    "database": { "status": "ok", "latency_ms": 12 },
    "redis":    { "status": "ok" },
    "queue":    { "status": "degraded", "pending": 8421 }
  }
}
```

Assertions use dot-paths into the body:

- `status` **equals** `ok`
- `checks.database.status` **equals** `ok`
- `checks.database.latency_ms` **less than** `100`
- `checks.queue.pending` **less than** `5000`

Each assertion can require equality, a numeric comparison, presence, or a substring match. The run is healthy only when **every** assertion passes. Intervals run from every **30 seconds** up to hourly, across multiple regions with consensus.

## What triggers an alert

- The endpoint is unreachable or returns a non-2xx status.
- The body isn't valid JSON, or an asserted path is missing.
- **Any** field assertion fails — e.g. `checks.queue.pending` exceeds its limit, or a nested `status` is `degraded`/`down`.

The incident resolves automatically once all assertions pass again.

## Setting it up

1. **Add monitor** and choose **Health Check**.
2. Enter the JSON health-endpoint URL (e.g. `https://api.example.com/health`).
3. Add **field assertions** using dot-paths and comparisons.
4. Set the **check interval** and **regions**.
5. Attach **notifications**.

## Related

- [Uptime](/monitors/uptime) · [Cron & Heartbeats](/monitors/cron-heartbeats) · [Performance](/monitors/performance)
- [Notifications](/operate/notifications)
- Marketing: [Health checks feature](https://uptime-status.org/features/health-checks)
