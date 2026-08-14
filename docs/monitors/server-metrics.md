---
title: Server Metrics
description: Push CPU, memory, and disk telemetry from your servers with a small cron collector and chart host health alongside your uptime checks.
---

# Server Metrics

Server metrics bring host-level telemetry — CPU, memory and disk — into the same place as your uptime and performance checks. Unlike every other monitor, it's **push-based**: your server sends metrics to StatusHQ, so it works for private servers with no inbound access.

## How it works

A small collector runs on each server. On an interval it samples the host and **pushes** a metrics payload to your ingest endpoint. StatusHQ gives you a ready-made shell snippet for this (see setup below) rather than a binary to install, so you can read exactly what it collects and adapt it — any cron job that can POST JSON works. Tracked signals:

- **CPU** utilisation (overall, `cpuPercent`)
- **Memory** utilisation (`ramPercent`) plus used / total in MB (`ramUsedMb` / `ramTotalMb`)
- **Disk** utilisation (`diskPercent`, optional - the supplied snippet reports the root filesystem)

Because it's push, there's nothing to expose publicly - the collector dials out to StatusHQ. Every sample is recorded as a check result, so it charts per host and feeds the same history and uptime machinery as any other monitor. A push is a JSON POST to `/api/agent/<metrics-token>/metrics` (the token appears on the monitor page once you enable metrics):

```bash
curl -fsS -X POST https://statushq.org/api/agent/<metrics-token>/metrics \
  -H "Content-Type: application/json" \
  -d '{"cpuPercent":37.2,"ramPercent":38.4,"ramUsedMb":6112,"ramTotalMb":16384,"diskPercent":68}'
```

The snippet does this for you on a schedule; the raw call is shown so you understand the shape. `cpuPercent`, `ramPercent`, `ramUsedMb`, and `ramTotalMb` are required (percentages 0-100); `diskPercent` is optional.

## What triggers an alert

- A metric crosses its **threshold**. Each push is evaluated against the monitor's thresholds - defaults are CPU `>= 90%`, memory `>= 90%`, and disk `>= 85%` (disk only when the collector reports it). A breach marks the host down and opens an [incident](/operate/incidents), which fans out to the monitor's [notification channels](/operate/notifications); the next healthy push resolves it. Set any threshold to `0` to disable that metric.
- **No metrics received** within the expected window (the collector stopped or the host is down) - a missed push works like a heartbeat. The window defaults to 300 seconds and is checked every minute.

Thresholds and the missed-push window live in the monitor's config (`cpuThreshold`, `ramThreshold`, `diskThreshold`, `metricsWindowSeconds`).

## Setting it up

1. **New monitor** in the dashboard. Server metrics are not a monitor *type* — they are a toggle, so any monitor can also report host telemetry (an uptime check on the site the box serves is the usual pairing).
2. Tick **This host pushes CPU, memory and disk samples**, and set the alert thresholds if the defaults (90 / 90 / 85) don't suit the host. Saving issues the host's ingest token.
3. Open the monitor and copy the **Agent setup** snippet — it already contains your ingest URL and token. Add it to the server's crontab (e.g. `* * * * *`).
4. Adjust the **missed-push window** (`metricsWindowSeconds`, default 300s) in the monitor's config if the host reports less often than once a minute.
5. Attach **notifications** so a breach reaches you.

## Related

- [Cron & Heartbeats](/monitors/cron-heartbeats) · [Performance](/monitors/performance) · [Port Scan](/monitors/port-scan)
- [Notifications](/operate/notifications)
- Marketing: [Server metrics feature](https://statushq.org/features/server-metrics)
