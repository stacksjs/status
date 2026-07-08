---
title: Maintenance windows
description: Schedule maintenance windows so planned work doesn't page on-call or dent your uptime percentage.
---

# Maintenance windows

Planned work — a deploy, a database migration, a provider upgrade — will make your checks fail. Without a heads-up, UptimeStatus would open [incidents](/operate/incidents), page on-call, and dock your uptime percentage for work you scheduled on purpose. A **maintenance window** tells UptimeStatus "this is expected."

## What a window does

For the monitors attached to it, during the scheduled window:

- **No paging.** A failing check inside the window does not open an incident or fire [notifications](/operate/notifications).
- **No uptime dent.** Time inside the window is excluded from the uptime percentage and the [status-page](/operate/status-pages) uptime-history bars, so a planned outage never shows as downtime.
- **Public "under maintenance" state.** Any status page that includes an affected component displays an **under maintenance** banner for the duration, so your users know it's intentional.

When the window ends, normal monitoring resumes automatically. If a monitor is still failing after the window closes, it opens an incident as usual.

## Creating a window

1. In the dashboard, go to **Maintenance** and click **Schedule window**.
2. Set the **start** and **end** times (and a timezone). One-off windows cover a single planned change. For regular work like weekly reboots, add a **recurrence** as a cron expression (for example `0 2 * * 0` for every Sunday at 02:00 UTC, or `@daily`); each occurrence keeps the same duration as the start-to-end you set here.
3. Add a short **description** — this is the message shown on the status page (e.g. "Scheduled database upgrade, expect ~10 min of downtime").
4. **Attach the monitors** the work affects. Only attached monitors are silenced; everything else keeps alerting normally, so an unrelated outage during your maintenance window still pages.
5. Save. The window is now active on schedule.

## Tips

- **Attach the smallest set of monitors** that the work actually touches. Over-attaching hides real, unrelated outages.
- **Pad the window** slightly on both ends — start it a few minutes before the change and end it a few minutes after, so a slow rollout or a lingering cache doesn't page you on the boundary.
- **Publish the description** on customer-facing pages ahead of time. Subscribers to a [status page](/operate/status-pages) that shows an affected monitor are emailed automatically when a window is within about a day away, so they hear about planned work before it starts. Recurring windows notify subscribers ahead of each occurrence.
