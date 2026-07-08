---
title: Ping Monitoring
description: ICMP reachability checks for hosts that don't speak HTTP, run from multiple regions as often as every 30 seconds.
---

# Ping Monitoring

Ping monitoring answers a simpler question than uptime: *is this host reachable on the network at all?* It uses ICMP echo, so it works for routers, load balancers, game servers, database hosts, and anything that responds to a ping but doesn't serve HTTP.

## How it works

On each run the checker sends ICMP echo request packets ("pings") to the target host and waits for echo replies. It measures:

- **Reachability** — did the host reply at all?
- **Round-trip time (RTT)** — how long each reply took, in milliseconds.
- **Packet loss** — the fraction of packets that went unanswered.

Pings are sent from **US-East** and additional regions, and an outage is confirmed by **regional consensus** so a single flaky network path doesn't false-alarm. Intervals range from every **30 seconds** up to hourly.

## What triggers an alert

- The host is **unreachable** — no replies received within the timeout.
- **Packet loss** exceeds your configured threshold (partial loss often signals a saturated link or failing hardware).
- **RTT** crosses a latency warning threshold, raising a warning rather than a hard down.

An incident resolves automatically once replies return cleanly across regions.

## Setting it up

1. **Add monitor** and choose **Ping**.
2. Enter the hostname or IP address (e.g. `db.internal.example.com` or `203.0.113.10`).
3. Set the **check interval** and select **regions**.
4. Configure thresholds: acceptable **packet loss %** (config `packetLossThresholdPercent`) and an optional **RTT** warning (`latencyThresholdMs`). The check sends `pingCount` packets (default 3) so partial loss is measurable; either threshold being crossed reports degraded.
5. Attach **notifications**.

> Ping only proves the host is up on the network — it does not verify that a service on it is accepting connections. To confirm a specific service, pair it with a [TCP Port](/monitors/tcp-port) or [Uptime](/monitors/uptime) check.

## Related

- [Uptime](/monitors/uptime) · [TCP Port](/monitors/tcp-port) · [Performance](/monitors/performance)
- [Notifications](/operate/notifications)
- Marketing: [Ping monitoring feature](https://uptime-status.org/features/ping-monitoring)
