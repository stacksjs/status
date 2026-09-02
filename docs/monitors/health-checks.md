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

## Already using spatie/laravel-health or Oh Dear?

StatusHQ reads that schema natively, so a Laravel app set up for Oh Dear works
here by changing a URL — no application changes:

```json
{
  "finishedAt": "1638879833",
  "checkResults": [
    { "name": "UsedDiskSpace", "label": "Used Disk Space", "status": "failed",
      "notificationMessage": "The disk is almost full (91% used)",
      "shortSummary": "91%", "meta": { "disk_space_used_percentage": 91 } }
  ]
}
```

Per-check statuses reduce to one monitor verdict: `failed` and `crashed` are
**down**, `warning` is **degraded**, `ok` is **up**, and `skipped` is ignored.
A status outside those five is treated as down rather than assumed healthy.

Two monitor config keys support it:

- `healthSecret` — sent as the `oh-dear-health-check-secret` header, the same
  header that package validates.
- `healthMaxAgeSeconds` — how stale a report may be, default **600**. A report
  whose `finishedAt` is older than this is down whatever the checks say, so a
  cached or frozen response can't report a dead application as healthy.

If the monitor has field assertions, those still win — your own contract
outranks the generic one.

## Running a Stacks app?

Nothing to set up. Every Stacks app serves `/health` from the moment it is
created — the framework registers `route.health()` in its default routes — and
StatusHQ reads that shape too:

```json
{
  "status": "ok",
  "timestamp": 1756382400000,
  "services": [
    { "name": "API", "status": "healthy", "latency": "2ms", "uptime": "99.9%" },
    { "name": "Database", "status": "critical", "latency": "-", "uptime": "-" }
  ]
}
```

Point a Health Check monitor at the app and leave the secret empty — a Stacks
`/health` route doesn't validate one. The format is detected from the response,
so there is no setting to pick.

Service statuses map onto the same verdicts as above: `healthy` is **up**,
`degraded` is **degraded**, and `critical` is **down**. Anything else is
treated as down rather than assumed healthy, so a status the framework adds
later fails closed until StatusHQ learns it.

`timestamp` is read as the report time, so `healthMaxAgeSeconds` applies here
exactly as it does to an Oh Dear report — a frozen response can't pass.

### `/api/health`, the probe format

Recent Stacks versions also answer `/api/health`, which reports each dependency
it probed rather than a list of services:

```json
{
  "status": "healthy",
  "checks": {
    "database": { "ok": true, "ms": 1 },
    "cache": { "ok": false, "ms": 1500, "message": "timeout" }
  },
  "timestamp": 1756382400000
}
```

StatusHQ reads this too, so set `path` to `/api/health` if that is the endpoint
your app exposes. It is the better target of the two: the app answers **503**
when a probe fails, and each probe's name and message are surfaced on the
monitor, so a failure reads as `cache check failed: timeout` rather than just
"down".

A probe that reports `ok: false` is **down**, not degraded. The app calls its
own overall status `degraded` when any probe fails, but an unreachable database
is not a partial success, and reading that word literally would leave the
monitor green through an outage.

One caveat worth knowing: `/api/health` is registered by the framework's
default dashboard routes, so an app that disables the dashboard in
`config/dashboard.ts`, or that gitignores its vendored `storage/framework/`
tree, will not serve it. Registering the route in your own `routes/` file makes
it independent of both.

### Node and Bun apps

There's no `spatie/laravel-health` equivalent in that ecosystem, so we ship
one: [`@statushq/agent`](https://github.com/stacksjs/status/tree/main/packages/agent)
exposes the same schema and also covers CPU, memory and disk — which the
Laravel package has no checks for.

```ts
import { createHealthHandler, defaultChecks } from '@statushq/agent'
const health = createHealthHandler({ checks: defaultChecks(), secret: process.env.STATUSHQ_HEALTH_SECRET })
```

It can also **push** host metrics instead, for boxes with no inbound HTTP —
see [Server Metrics](/monitors/server-metrics).

## Related

- [Uptime](/monitors/uptime) · [Cron & Heartbeats](/monitors/cron-heartbeats) · [Performance](/monitors/performance)
- [Notifications](/operate/notifications)
- Marketing: [Health checks feature](https://statushq.org/features/health-checks)
