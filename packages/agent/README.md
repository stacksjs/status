# @statushq/agent

Report host metrics and application health to StatusHQ from any Bun or Node app.

Two transports, because they answer different questions:

- **push** — your process sends CPU/RAM/disk to StatusHQ on a timer. Works on a
  box with no inbound HTTP, behind NAT, and keeps reporting while your web app
  is down. Each host has its own token, so three nodes behind a load balancer
  are three series.
- **pull** — you expose an endpoint, StatusHQ polls it. Nothing to schedule, and
  the report says when it was produced so a frozen response can't read as
  healthy.

Everything is measured with native APIs — `os.cpus()`, `os.totalmem()`,
`fs.statfs()`. No shelling out to `df`, so it works where `proc_open` and
friends are unavailable.

## Push metrics

```ts
import { startReporter } from '@statushq/agent'

const reporter = startReporter({
  url: 'https://statushq.org',
  token: process.env.STATUSHQ_METRICS_TOKEN!, // Agent setup card on the monitor page
  intervalMs: 60_000,
})

process.on('SIGTERM', () => reporter.stop())
```

The timer is unref'd, so it never keeps a process alive by itself.

## Expose a health endpoint

```ts
import { createHealthHandler, defaultChecks } from '@statushq/agent'

const health = createHealthHandler({
  checks: defaultChecks(), // disk, memory, CPU
  secret: process.env.STATUSHQ_HEALTH_SECRET,
})

Bun.serve({
  port: 3000,
  fetch(request) {
    if (new URL(request.url).pathname === '/health-check-results')
      return health(request)
    return new Response('ok')
  },
})
```

Then point a StatusHQ `health` monitor at that URL and set `healthSecret` in
its config. The secret travels in the `oh-dear-health-check-secret` header.

### Your own checks

A check is any function returning a result. Throwing is reported as `crashed`
rather than taking the endpoint down with it.

```ts
import { createHealthHandler, defaultChecks, type Check } from '@statushq/agent'

const queueCheck: Check = async () => {
  const depth = await queue.size()
  return {
    name: 'QueueDepth',
    label: 'Queue depth',
    status: depth > 10_000 ? 'failed' : depth > 1_000 ? 'warning' : 'ok',
    notificationMessage: depth > 1_000 ? `Queue backed up: ${depth} jobs` : '',
    shortSummary: `${depth}`,
    meta: { depth },
  }
}

createHealthHandler({ checks: [...defaultChecks(), queueCheck] })
```

## Schema

The endpoint emits the schema `spatie/laravel-health` uses, so it is readable
by StatusHQ *and* Oh Dear with no adapter:

```json
{
  "finishedAt": "1638879833",
  "checkResults": [
    {
      "name": "UsedDiskSpace",
      "label": "Used disk space",
      "status": "failed",
      "notificationMessage": "Used disk space is at 91% (threshold 90%)",
      "shortSummary": "91%",
      "meta": { "disk_space_used_percentage": 91 }
    }
  ]
}
```

Statuses are `ok`, `warning`, `failed`, `crashed`, `skipped`. StatusHQ maps
`failed`/`crashed` to down, `warning` to degraded, and ignores `skipped`. A
report older than the monitor's `healthMaxAgeSeconds` (default 600) is down
whatever the checks say.

## A note on memory

On Linux this reads `MemAvailable` from `/proc/meminfo`, not `os.freemem()`.
`freemem()` maps to `MemFree`, which excludes reclaimable page cache — on a
healthy long-running server that reports 90%+ used and would page you
continuously. `MemAvailable` is the kernel's own estimate of what a new
workload could actually get.

## Which one should I use?

Both, usually. Push gives you true per-host CPU/RAM/disk. Pull tells you
whether the *application* is healthy — database reachable, queue moving,
scheduler alive — which is a different question, and one that per-host metrics
cannot answer.
