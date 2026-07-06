---
title: Performance Monitoring
description: Track response-time trends across regions and catch slow regressions before they become outages.
---

# Performance Monitoring

Sites rarely fail all at once — they get slow first. Performance monitoring tracks your response-time trends over time and alerts on regressions, so a deploy that quietly doubled your latency gets flagged before users start leaving.

## How it works

On each run the checker fetches your target and records a full timing breakdown, not just a single number:

- **DNS lookup** time
- **TCP connect** and **TLS handshake** time
- **Time to first byte (TTFB)**
- **Total response time**

These are stored per region and charted so you can see p50/p95 trends, compare regions, and correlate a jump with a deploy. Checks run from **US-East** and additional regions as often as every **30 seconds**.

Performance monitoring evaluates against a **rolling baseline** as well as fixed thresholds — so it can catch a gradual creep that no single static limit would trip.

## What triggers an alert

- Total response time (or TTFB) exceeds a **fixed warning/critical threshold** you set.
- A **regression versus the rolling baseline** — e.g. p95 latency is materially worse than the trailing window.
- Degradation confirmed across **multiple regions**, ruling out a single noisy path.

## Setting it up

1. **Add monitor** and choose **Performance**.
2. Enter the target URL.
3. Set the **check interval** and **regions**.
4. Configure **thresholds** (warning + critical) and, optionally, regression sensitivity against the baseline.
5. Attach **notifications**.

> Performance and [Uptime](/monitors/uptime) complement each other: uptime tells you it's *down*, performance tells you it's *getting worse*. Many teams run both on their critical endpoints.

## Related

- [Uptime](/monitors/uptime) · [Lighthouse](/monitors/lighthouse) · [Health Checks](/monitors/health-checks)
- [Notifications](/operate/notifications)
- Marketing: [Performance monitoring feature](https://uptime-status.org/features/performance-monitoring)
