---
title: Cron & Heartbeat Monitoring
description: Watch scheduled jobs by expecting a ping on a cadence and alert the moment a heartbeat is overdue.
---

# Cron & Heartbeat Monitoring

Cron and heartbeat monitoring is inside-out: instead of UptimeStatus reaching out to your service, *your job reaches out to UptimeStatus*. Each successful run pings a unique URL. If the expected ping doesn't arrive on schedule, we alert you — so a backup that silently stopped running gets caught, not just one that errored loudly.

## How it works

Every heartbeat monitor has a unique ping URL and an expected **cadence** plus a **grace period**. Your job requests that URL when it finishes successfully. UptimeStatus records the ping and starts a countdown for the next one:

- **Received on time** → the monitor stays healthy.
- **Overdue past the grace period** → the monitor goes down and alerts fire.

Cadence can be as tight as every **30 seconds** or as loose as monthly. The grace period absorbs normal jitter (a nightly job that usually finishes at 02:03 but sometimes 02:09).

Have the job ping on success — a plain GET or POST is enough:

```bash
# Run at the end of your cron job, only on success
0 2 * * *  /usr/local/bin/backup.sh && curl -fsS -m 10 --retry 3 \
  https://uptime-status.org/ping/9f3c1a2e-heartbeat-token
```

You can also signal **start** and **failure** to measure run duration and catch non-zero exits:

```bash
curl -fsS https://uptime-status.org/ping/<token>/start   # job began
curl -fsS https://uptime-status.org/ping/<token>/fail    # job errored
```

## What triggers an alert

- No ping arrives within the **cadence + grace period** (the job is overdue, hung, or the box is down).
- An explicit `/fail` ping is received.
- A `/start` with no matching success within the grace window (run took too long).

## Setting it up

1. **Add monitor** and choose **Cron / Heartbeat**.
2. Set the expected **cadence** and a **grace period**. Cadence can be a plain interval (every 30 seconds up to monthly) or a 5-field cron expression such as `0 2 * * *` (daily at 02:00 UTC) or a nickname like `@hourly`. When a cron expression is set, the next expected check-in is the next scheduled slot; the interval is used otherwise.
3. Copy the generated **ping URL**.
4. Add the `curl` ping to the end of your job, as shown above.
5. Attach **notifications**.

## Related

- [Health Checks](/monitors/health-checks) · [Uptime](/monitors/uptime) · [Server Metrics](/monitors/server-metrics)
- [Notifications](/operate/notifications)
- Marketing: [Cron & heartbeat monitoring feature](https://uptime-status.org/features/cron-monitoring)
