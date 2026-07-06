# Second region — push-probe deployment (what's actually live)

This is the topology **running in production** for the US-East (Ashburn)
second region. It supersedes the shared-Postgres + WireGuard cutover in
[second-region-runbook.md](second-region-runbook.md) — that approach still
works and its code is intact, but a live SQLite→Postgres migration of a
running monitor is high-risk, so the second region instead ships on a
**push-probe** model that needs no shared/networked database and never
touches the primary's SQLite.

## How it works

```
  Ashburn box (us-east)                      Primary (eu-central, SQLite)
  ┌───────────────────────┐                  ┌────────────────────────────┐
  │ region-probe.timer     │  GET monitors   │ /api/regions/{token}/monitors│
  │  → region-probe.ts ────┼─────────────────▶                            │
  │    runs uptime/ping/    │  POST results   │ /api/regions/{token}/results │
  │    tcp/health checks ───┼─────────────────▶  writes region='us-east'    │
  │    from US-East         │                  │  CheckResult rows           │
  └───────────────────────┘                  │                            │
                                              │ EvaluateMonitorConsensus    │
                                              │  (every min) weighs         │
                                              │  eu-central + us-east votes │
                                              └────────────────────────────┘
```

The primary keeps writing its own checks tagged `eu-central`
(`WORKER_REGION`); the probe box adds `us-east`. `EvaluateMonitorConsensus`
opens an incident only when `CONSENSUS_MIN_REGIONS` (2) regions agree a
monitor is down — a single region's blip can't page anyone. If a region
goes silent, the freshness window drops its stale votes and the threshold
clamps to the regions that did report, so a real outage still alerts.

## Primary side (ships via CI git-push, no SSH)

- `app/Actions/Regions/` — `ListRegionMonitorsAction` (GET monitors),
  `IngestRegionResultsAction` (POST results), `RegionStatusAction` (GET
  status, read-only introspection for verifying the fleet). Auth is the
  unguessable `REGIONAL_INGEST_TOKEN` in the URL (constant-time compare in
  `regionToken.ts`); endpoints stay closed when the token is unset.
- `routes/api.ts` — the three `/regions/{token}/…` routes.
- `.env.production` — `REGIONAL_INGEST_TOKEN` (encrypted with
  `./buddy env:set … --file .env.production`), `WORKER_REGION=eu-central`,
  `MONITOR_REGIONS=eu-central,us-east`.

## Probe box (Ashburn)

- Provision a cheap box in `ash`: `cpx11`, Ubuntu, the account SSH key.
  cloud-init installs `bun` to `/usr/local` and `iputils-ping`.
- `scripts/region-probe.ts` → `/opt/uptime-status/scripts/region-probe.ts`
- `scripts/deploy/region-probe.{service,timer}` →
  `/etc/systemd/system/`, then `systemctl enable --now region-probe.timer`
  (runs every 60s).
- `/etc/uptime-status/region-probe.env` (chmod 600):
  ```
  PRIMARY_URL=https://uptime-status.org
  REGIONAL_INGEST_TOKEN=<same token as the primary>
  WORKER_REGION=us-east
  PROBE_TIMEOUT_MS=15000
  ```

## Verify end to end

```sh
# From anywhere — shows per-region votes and the consensus verdict:
curl -s "https://uptime-status.org/api/regions/$TOKEN/status" | jq
```
Expect both `eu-central` and `us-east` under each monitor's `regions`, and
`consensus` matching `stored_status`. On the probe box,
`journalctl -u region-probe.service` shows each 60s run's report.

## Add a third region

Clone the probe box in the new location, set its `WORKER_REGION` (e.g.
`us-west`), and append it to `MONITOR_REGIONS` on the primary. No code
change — the consensus job and endpoints are region-agnostic.
