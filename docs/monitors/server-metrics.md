---
title: Server Metrics
description: Push CPU, memory, and disk telemetry from your servers with a lightweight agent and chart host health alongside your uptime checks.
---

# Server Metrics

Server metrics bring host-level telemetry — CPU, memory, disk, load — into the same place as your uptime and performance checks. Unlike every other monitor, it's **push-based**: a small agent on your box sends metrics to UptimeStatus, so it works for private servers with no inbound access.

## How it works

You install a lightweight agent on each server. On an interval, the agent samples the host and **pushes** a metrics payload to your ingest endpoint. Tracked signals include:

- **CPU** utilisation (overall and per-core)
- **Memory** used / available
- **Disk** usage per mount
- **Load average** and uptime

Because it's push, there's nothing to expose publicly — the agent dials out to UptimeStatus. Metrics are charted per host and retained for trend analysis. A typical agent push looks like:

```bash
curl -fsS -X POST https://uptime-status.org/api/metrics/<host-token> \
  -H "Content-Type: application/json" \
  -d '{"cpu":37.2,"mem_used":6112,"mem_total":16384,"disk_used_pct":68,"load1":1.24}'
```

The agent handles this for you on a schedule; the raw call is shown so you understand the shape.

## What triggers an alert

- A metric crosses a **threshold** — e.g. CPU `> 90%` sustained, disk `> 85%`, or memory near exhaustion.
- **No metrics received** within the expected window (the agent stopped or the host is down) — a missed-push works like a heartbeat.

## Setting it up

1. **Add monitor** and choose **Server Metrics**.
2. Copy the **host token** / ingest URL for the new host.
3. Install and start the **agent** on your server with that token.
4. Set **thresholds** for CPU, memory, and disk, plus a missed-push window.
5. Attach **notifications**.

## Related

- [Cron & Heartbeats](/monitors/cron-heartbeats) · [Performance](/monitors/performance) · [Port Scan](/monitors/port-scan)
- [Notifications](/operate/notifications)
- Marketing: [Server metrics feature](https://uptime-status.org/features/server-metrics)
