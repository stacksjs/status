---
title: Uptime Monitoring
description: HTTP(S) uptime checks with status-code, latency, and keyword assertions, run from multiple regions as often as every 30 seconds.
---

# Uptime Monitoring

Uptime monitoring is the core availability check: UptimeStatus fetches a URL on a schedule from multiple regions and tells you the moment it stops responding the way it should. It is the check most people mean when they say "is my site down?"

## How it works

On each run the checker opens an HTTP(S) request to your target URL and measures three things: whether it connected at all, the HTTP status code it received, and the total response latency. You can layer on assertions:

- **Status code** — expect `200`, a range like `200–299`, or an explicit list.
- **Response body / keyword** — assert that the body *contains* (or does *not* contain) a string, so a `200` that renders an error page still fails.
- **Latency** — flag a run as degraded when it exceeds a warning threshold.

Checks run from **US-East** and additional regions, and a failure is only declared after **regional consensus** — a single region blipping won't page you. Intervals range from every **30 seconds** up to hourly.

## What triggers an alert

- The request times out, the connection is refused, or DNS/TLS fails.
- The status code falls outside your expected set.
- A required keyword is missing, or a forbidden keyword appears.
- Multiple regions agree the target is unhealthy (consensus), which resolves automatically once healthy runs return.

Latency-threshold breaches raise a **warning** rather than a hard down, so you can catch slowness before it becomes an outage.

## Setting it up

1. **Add monitor** in the dashboard and choose **Uptime**.
2. Enter the target URL (e.g. `https://example.com/health`).
3. Set the **check interval** (30s–1h) and pick your **regions**.
4. Add assertions: expected status code, keyword match, and a latency warning threshold (config `latencyThresholdMs`; a run at or over it is reported degraded).
5. Attach **notifications** so the right people are alerted.

## Related

- [Ping](/monitors/ping) · [TCP Port](/monitors/tcp-port) · [Health Checks](/monitors/health-checks) · [Performance](/monitors/performance)
- [Notifications](/operate/notifications)
- Marketing: [Uptime monitoring feature](https://uptime-status.org/features/uptime-monitoring)
