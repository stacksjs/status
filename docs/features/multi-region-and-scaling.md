# Multi-region checks & queue scaling

Deployment/infrastructure guidance for running Status's check workers at real
scale — distinct from application code, since this is about how you run the
process(es), not what they do (see [stacksjs/status#1](https://github.com/stacksjs/status/issues/1),
Phase 11).

## Multi-region checks

A monitor checked from a single network location can't distinguish "the
target is actually down" from "our one probe location lost its route to the
target" — a transient blip between your worker and, say, an AWS region
having a bad minute reads as a false-positive outage. Oh Dear (and every
serious uptime monitor) checks from multiple regions and only opens an
incident when more than one region agrees.

**How this app supports it today:**

- `CheckResult.region` (see [CheckResult.ts](../../app/Models/CheckResult.ts))
  already records which probe location produced each result.
- `RunUptimeCheck`, `RunPingCheck`, `RunTcpPortCheck`, `RunHealthCheck`, and
  `RunBlocklistCheck` stamp `region` from the `WORKER_REGION` env var
  (defaults to `"default"` — see `.env.example`).

**How to actually run multi-region:**

1. Deploy the check-worker process (`./buddy queue:work --queue=checks`) to
   N independent hosts/regions (e.g. one in `us-east`, one in `eu-west`),
   each with a distinct `WORKER_REGION` set and pointed at the *same* queue
   backend (Redis or the shared database — see Queue scaling below). Don't
   run the scheduler (`app/Scheduler.ts`, which dispatches `DispatchDueChecks`
   every minute) in more than one region — it only needs to *enqueue* jobs
   once; any worker in any region can pick a job off the shared queue and
   run it locally from that region.
2. Start with 1-2 regions. Every additional region is a proportional
   increase in outbound check traffic against every monitored target — do
   not add regions before the multi-region *analysis* below exists, or
   you're 3x-ing check volume for no consensus benefit.
3. **Not yet implemented** (net-new application code, not just deployment):
   consensus logic in `RunUptimeCheck` et al. that only opens an `Incident`
   once N-of-M regions report the same monitor down within a short window,
   rather than the current single-result transition. Until that lands,
   multi-region deployment gives you per-region `CheckResult` visibility
   (useful for manually distinguishing a regional network issue from a real
   outage) but every region's job still independently opens/resolves
   incidents on its own transition — running >1 region before that lands
   will produce *more* noise, not less, so keep `WORKER_REGION` at its
   default single value until the consensus logic is built.

## Queue scaling

Check jobs (`app/Jobs/Run*Check.ts`, fanned out by `DispatchDueChecks` every
minute — see `app/Scheduler.ts`) are the dominant workload at any real
monitor count: N monitors on a 60s interval means N jobs/minute minimum,
before Lighthouse/crawl/port-scan jobs (each far more expensive than a
single HTTP check) are counted.

**Driver choice** (`QUEUE_DRIVER` in `.env`, see [config/queue.ts](../../config/queue.ts)):

- `sync` — executes inline, no real queue. Development only; never use in
  production, it serializes every check onto whatever process dispatched it.
- `database` — durable, no extra infrastructure, but polling-based. Fine at
  low-to-moderate monitor counts; the `jobs` table becomes a write hotspot
  as volume grows.
- `redis` — recommended for any real deployment. Backed by `bun-queue`:
  distributed locking, leader election, and rate limiting come for free,
  which is exactly what horizontal worker scaling needs (multiple worker
  processes safely pulling from the same queue with no double-processing).

**Horizontal scaling**, once on the `redis` driver:

- Each `Run*Check` job already declares its own `queue` (`'checks'` for
  check jobs, `'notifications'` for outbound alerts — see e.g.
  [RunUptimeCheck.ts](../../app/Jobs/RunUptimeCheck.ts),
  [SendNotification.ts](../../app/Jobs/SendNotification.ts)). Run separate
  `buddy queue:work --queue=checks` and `buddy queue:work --queue=notifications`
  worker pools so a burst of outbound webhook/Slack/PagerDuty sends never
  delays the next round of uptime checks, and vice versa.
- Scale each pool by running more worker *processes* (more hosts, or more
  processes per host) — the Redis driver's distributed lock means this is
  safe with no coordination beyond pointing every process at the same
  `REDIS_URL`. Per-process concurrency (jobs processed simultaneously
  within one process) is `QUEUE_CONCURRENCY` (default 5); process count is
  how you scale beyond one machine's practical concurrency ceiling.
- `buddy queue:status` / `buddy queue:monitor` (see
  [queue.ts](../../storage/framework/core/buddy/src/commands/queue.ts))
  give live visibility into queue depth per worker — the signal to watch
  when deciding whether to add worker processes: sustained queue depth
  growth (jobs enqueued faster than they drain) means add workers, not just
  a burst that clears itself.
- Load-testing throughput before scaling a real fleet: seed a large number
  of `Monitor` rows (`useSeeder` is already configured on every monitoring
  model) at a short `checkIntervalSeconds`, point `DispatchDueChecks` at
  them, and watch `buddy queue:status` queue depth over a sustained window
  rather than a single burst — this is left as a deployment-time exercise
  since realistic throughput depends entirely on target-site response
  latency (a check job's wall-clock time is dominated by the remote
  `fetch()`, not local CPU), which varies per deployment's monitored set.

## Related

- [CheckWorkerHealth](../../app/Jobs/CheckWorkerHealth.ts) — a self-check
  for the pipeline itself (`WORKER_HEARTBEAT_URL`), complementary to but
  distinct from the scaling concerns here: it tells you the pipeline
  *stopped*, not that it's under-provisioned.

## Custom status page domains

A team can point a CNAME at this app and serve their status page at their
own domain instead of `/status/{slug}` (stacksjs/status#1 Phase 7):

1. Set `StatusPage.customDomain` to the desired hostname (e.g.
   `status.acme.com`).
2. The customer adds a CNAME record for that hostname pointing at wherever
   this app is deployed.
3. TLS for the custom domain is the deployer's responsibility (e.g. a
   reverse proxy or load balancer terminating TLS for the additional
   hostname) — this app does not provision certificates per custom domain.

**How resolution works:** `resources/views/index.stx` (the file that owns
the app's own `/` route) checks the incoming request's `host` — exposed to
every `<script server>` block as an ambient variable added specifically for
this feature (see `~/Code/Tools/stx` `packages/bun-plugin/src/serve.ts`,
`activeServeHost`) — against `StatusPage.customDomain`. On a match it
renders that team's status page instead of the marketing landing page; any
other host renders the landing page as before. This has to live in
`index.stx` rather than a dedicated route because this router's static
file-based views take priority over programmatic `route.get()` registrations
at the same path — a `route.get('/', ...)` action is simply never reached
for `/`.
