# @statushq/agent

Report host metrics and application health to StatusHQ from any Bun or Node
app — and from Stacks apps in particular.

Two transports, because they answer different questions:

- **push** — your process sends CPU/RAM/disk to StatusHQ on a timer. Works on a
  box with no inbound HTTP, behind NAT, and keeps reporting while your web app
  is down. Each sample carries its host, so three nodes behind a load balancer
  are three series rather than whichever one answered.
- **pull** — you expose an endpoint, StatusHQ polls it. Nothing to schedule, and
  it is the only thing that proves the app is reachable from outside: a silent
  agent and a dead network look identical from the receiving end.

Everything is measured with native APIs — `/proc`, the cgroup filesystem,
`os.cpus()`, `fs.statfs()`. Nothing shells out to `df`.

This is the Bun/Node counterpart of [`statushq/laravel`](https://github.com/bughq/statushq-laravel).
Both emit the same wire format, so one StatusHQ monitor reads either.

## No code at all

```bash
bunx @statushq/agent report --token $STATUSHQ_TOKEN
```

For a plain box, that plus cron is the whole install:

```cron
* * * * * statushq-agent report --token $STATUSHQ_TOKEN
```

`report` takes both CPU readings a second apart, which is fine for cron and
wrong inside a server — use `startReporter` there. `watch` runs in the
foreground on an interval for systemd or a container. `--dry` prints the
sample instead of sending it.

## Push from a long-lived process

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

**The first tick sends nothing, on purpose.** CPU usage is a rate and needs two
counter readings to exist. A number derived from one reading is the machine's
average since boot, which on a box that has been idle all week and is pinned
right now reads as roughly zero — and nobody would ever catch it, because that
is also exactly what a genuinely idle box looks like.

## Expose a health endpoint

```ts
import { createHealthHandler, defaultChecks } from '@statushq/agent'

const health = createHealthHandler({
  checks: defaultChecks(),
  secret: process.env.STATUSHQ_HEALTH_SECRET, // sent as oh-dear-health-check-secret
})

Bun.serve({
  port: 3000,
  fetch: (request) => new URL(request.url).pathname === '/health'
    ? health(request)
    : new Response('ok'),
})
```

Inside a server, hand the CPU check a shared sampler so it differences against
the previous poll instead of blocking the event loop for a second:

```ts
import { createCpuSampler, defaultChecks } from '@statushq/agent'

const sampler = createCpuSampler()
const health = createHealthHandler({ checks: defaultChecks({ sampler }) })
```

It reports `skipped` until it has been polled twice.

## In a Stacks app

Stacks owns its `app/` directory, so this is two small files rather than a
plugin. Push from the scheduler:

```ts
// app/Jobs/ReportMetrics.ts
import { Job } from '@stacksjs/queue'
import { collect, metricsEndpoint } from '@statushq/agent'

export default new Job({
  name: 'ReportMetrics',
  description: 'Push a CPU, memory and disk sample to StatusHQ',
  tries: 1,
  timeout: 30,
  handle: async () => {
    const token = process.env.STATUSHQ_METRICS_TOKEN
    if (!token)
      return

    await fetch(metricsEndpoint(process.env.STATUSHQ_URL ?? 'https://statushq.org', token), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await collect()),
    })
  },
})
```

```ts
// app/Scheduler.ts
schedule.job('ReportMetrics').everyMinute()
```

And serve the pull endpoint from a route, using the same handler:

```ts
// routes/api.ts — see also Actions/ if you prefer the action convention
route.get('/health', () => health(new Request('http://local/health')))
```

## Containers

Memory is read from the **cgroup** before `/proc/meminfo`, and before
`os.totalmem()`. That ordering is the substance of this package rather than a
detail: inside a container both of the latter describe the *host*, so an app
capped at 512 MB on a 64 GB box reads as 3% used while it is being OOM-killed.

CPU is the same story. When the container has a quota, usage is measured
against the quota — a container limited to half a core on a 32-core host is at
100% of what it may use, while `/proc/stat` reports 1.5%.

The resolution order, and what each check reports in `meta.source`:

| | order |
|---|---|
| memory | `cgroup-v2` → `cgroup-v1` → `proc-meminfo` → `os` |
| cpu | `cgroup-v2` → `cgroup-v1` → `proc-stat` → `os` |

`os` is macOS and Windows, where there is no `/proc`. Note that `os.freemem()`
maps to `MemFree` and ignores reclaimable cache, so it overstates usage — it is
the only thing available off Linux, and the `source` field is how you tell.

## When it can't tell

Never a plausible-looking zero. Readings that cannot be derived come back
`null`, checks report `skipped` (which StatusHQ ignores rather than counting as
healthy), and pushes are withheld:

- the first CPU sample after a restart, as above;
- a counter reset by a reboot — the delta goes negative, so it is discarded;
- two readings from different sources, e.g. a quota added to a running
  deployment switches jiffies for microseconds;
- a gap wider than 15 minutes, where the average no longer describes now.

## Custom checks

```ts
import { createHealthHandler, defaultChecks, type Check } from '@statushq/agent'

const database: Check = async () => {
  const start = performance.now()
  await db.query('select 1')
  const ms = Math.round(performance.now() - start)

  return {
    name: 'Database',
    label: 'Database',
    status: ms < 100 ? 'ok' : 'warning',
    notificationMessage: ms < 100 ? '' : `Database took ${ms}ms`,
    shortSummary: `${ms}ms`,
    meta: { latency_ms: ms },
  }
}

const health = createHealthHandler({ checks: [...defaultChecks(), database] })
```

A check that throws is reported as `crashed` rather than taking the endpoint
down with it, and the endpoint always returns **200** — the status code answers
"did the endpoint work", the body answers "is the app healthy".

## Testing your own endpoint

Every reader takes an injectable `FileReader`, so a full disk or a
memory-capped container is a fixture rather than a situation you have to
create:

```ts
import { memory } from '@statushq/agent'

const files = (path: string) => ({
  '/sys/fs/cgroup/memory.max': String(512 * 1024 * 1024),
  '/sys/fs/cgroup/memory.current': String(500 * 1024 * 1024),
}[path] ?? null)

expect(memory(files).ramPercent).toBe(98)
```

## License

MIT.
