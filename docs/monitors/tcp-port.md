---
title: TCP Port Monitoring
description: Confirm that a TCP port accepts connections for databases, SMTP, and custom services, checked from multiple regions as often as every 30 seconds.
---

# TCP Port Monitoring

TCP port monitoring verifies that a specific service is *listening and accepting connections* on a given port. It's the right check for anything that speaks a raw TCP protocol rather than HTTP — Postgres, MySQL, Redis, SMTP, IMAP, SSH, message brokers, and custom services.

## How it works

On each run the checker opens a TCP connection (a full three-way handshake) to `host:port`. It measures:

- **Connectivity** — did the port accept the connection?
- **Connect latency** — how long the handshake took.

A successful handshake means something is bound to that port and ready to talk. Checks run from **US-East** and additional regions with **regional consensus** before an outage is declared. Intervals go from every **30 seconds** up to hourly.

Common targets:

| Service   | Port |
|-----------|------|
| PostgreSQL | 5432 |
| MySQL      | 3306 |
| Redis      | 6379 |
| SMTP       | 25 / 587 |
| SSH        | 22   |

## What triggers an alert

- The connection is **refused** (nothing listening), **times out** (firewall/host down), or is **reset**.
- Connect latency crosses a warning threshold.

Incidents resolve automatically once the port starts accepting connections again across regions.

## Setting it up

1. **Add monitor** and choose **TCP Port**.
2. Enter the **host** and **port** (e.g. `db.example.com:5432`).
3. Set the **check interval** and select **regions**.
4. Optionally set a **connect-latency** warning threshold (config `latencyThresholdMs`; an open-but-slow port is reported degraded).
5. Attach **notifications**.

> A successful TCP handshake confirms the port is open, not that the application behind it is fully healthy. For app-level health, add a [Health Check](/monitors/health-checks) or [Uptime](/monitors/uptime) check.

## Related

- [Uptime](/monitors/uptime) · [Ping](/monitors/ping) · [Health Checks](/monitors/health-checks) · [Port Scan](/monitors/port-scan)
- [Notifications](/operate/notifications)
- Marketing: [TCP port monitoring feature](https://uptime-status.org/features/tcp-port-monitoring)
