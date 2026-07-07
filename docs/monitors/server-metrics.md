---
title: Server Metrics
description: Push CPU, memory, and disk telemetry from your servers with a lightweight agent and chart host health alongside your uptime checks.
---

# Server Metrics

Server metrics bring host-level telemetry — CPU, memory, disk, load — into the same place as your uptime and performance checks. Unlike every other monitor, it's **push-based**: a small agent on your box sends metrics to UptimeStatus, so it works for private servers with no inbound access.

## How it works

You install a lightweight agent on each server. On an interval, the agent samples the host and **pushes** a metrics payload to your ingest endpoint. Tracked signals:

- **CPU** utilisation (overall, `cpuPercent`)
- **Memory** utilisation (`ramPercent`) plus used / total in MB (`ramUsedMb` / `ramTotalMb`)
- **Disk** utilisation (`diskPercent`, optional - send it if your agent collects it)

Because it's push, there's nothing to expose publicly - the agent dials out to UptimeStatus. Every sample is recorded as a check result, so it charts per host and feeds the same history and uptime machinery as any other monitor. A push is a JSON POST to `/api/agent/<metrics-token>/metrics` (the token is shown when you enable metrics on the monitor):

```bash
curl -fsS -X POST https://uptime-status.org/api/agent/<metrics-token>/metrics \
  -H "Content-Type: application/json" \
  -d '{"cpuPercent":37.2,"ramPercent":38.4,"ramUsedMb":6112,"ramTotalMb":16384,"diskPercent":68}'
```

The agent handles this for you on a schedule; the raw call is shown so you understand the shape. `cpuPercent`, `ramPercent`, `ramUsedMb`, and `ramTotalMb` are required (percentages 0-100); `diskPercent` is optional.

## What triggers an alert

- A metric crosses its **threshold**. Each push is evaluated against the monitor's thresholds - defaults are CPU `>= 90%`, memory `>= 90%`, and disk `>= 85%` (disk only when the agent reports it). A breach marks the host down and opens an [incident](/operate/incidents), which fans out to the monitor's [notification channels](/operate/notifications); the next healthy push resolves it. Set any threshold to `0` to disable that metric.
- **No metrics received** within the expected window (the agent stopped or the host is down) - a missed push works like a heartbeat. The window defaults to 300 seconds and is checked every minute.

Thresholds and the missed-push window live in the monitor's config (`cpuThreshold`, `ramThreshold`, `diskThreshold`, `metricsWindowSeconds`).

## Setting it up

1. **Add monitor** and choose **Server Metrics**.
2. Copy the **host token** / ingest URL for the new host.
3. Install and start the **agent** on your server with that token.
4. Adjust the **thresholds** (`cpuThreshold`, `ramThreshold`, `diskThreshold`) and the **missed-push window** (`metricsWindowSeconds`) in the monitor's config if the defaults (90 / 90 / 85, 300s) don't suit the host.
5. Attach **notifications**.

## Related

- [Cron & Heartbeats](/monitors/cron-heartbeats) · [Performance](/monitors/performance) · [Port Scan](/monitors/port-scan)
- [Notifications](/operate/notifications)
- Marketing: [Server metrics feature](https://uptime-status.org/features/server-metrics)
