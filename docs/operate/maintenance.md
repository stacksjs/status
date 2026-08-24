---
title: Maintenance windows
description: Schedule maintenance windows so planned work doesn't page on-call or dent your uptime percentage.
---

# Maintenance windows

Planned work — a deploy, a database migration, a provider upgrade — will make your checks fail. Without a heads-up, StatusHQ would open [incidents](/operate/incidents), page on-call, and dock your uptime percentage for work you scheduled on purpose. A **maintenance window** tells StatusHQ "this is expected."

## What a window does

For the monitors attached to it, during the scheduled window:

- **No paging.** A failing check inside the window does not open an incident or fire [notifications](/operate/notifications).
- **No uptime dent.** Time inside the window is excluded from the uptime percentage and the [status-page](/operate/status-pages) uptime-history bars, so a planned outage never shows as downtime.
- **Public "under maintenance" state.** Any status page that includes an affected component displays an **under maintenance** banner for the duration, so your users know it's intentional.

When the window ends, normal monitoring resumes automatically. If a monitor is still failing after the window closes, it opens an incident as usual.

## Creating a window

1. In the dashboard, go to **Maintenance** and fill in **Schedule window**.
2. Set the **start** and **end** times. These are **UTC**, matching the rest of the dashboard — the fields are labelled so, and a window is stored exactly as typed rather than being shifted by the browser's timezone. One-off windows cover a single planned change. For regular work like weekly reboots, add a **repeat** as a cron expression (for example `0 2 * * 0` for every Sunday at 02:00 UTC, or `@weekly`); each occurrence keeps the same duration as the start-to-end you set here.
3. Add a short **description** — this is the message shown on the status page (e.g. "Scheduled database upgrade, expect ~10 min of downtime").
4. Save, then **attach the monitors** the work affects on the window's own page. Only attached monitors are silenced; everything else keeps alerting normally, so an unrelated outage during your maintenance window still pages. A window with nothing attached announces itself to subscribers but suppresses nothing, and both maintenance pages warn you when they find one.
5. Check the **Occurrences** list on that page. It is expanded with the same code that does the suppression, so if a repeat expression is wrong you will see it produce the wrong dates — or none — before the maintenance runs rather than after nobody got paged.

To call off planned work, set the window's status to **Cancelled** rather than deleting it: a cancelled window means the maintenance did not happen, so its time counts against uptime again and its monitors resume paging. Delete is for windows created by mistake.

## Tips

- **Attach the smallest set of monitors** that the work actually touches. Over-attaching hides real, unrelated outages.
- **Pad the window** slightly on both ends — start it a few minutes before the change and end it a few minutes after, so a slow rollout or a lingering cache doesn't page you on the boundary.
- **Publish the description** on customer-facing pages ahead of time. Subscribers to a [status page](/operate/status-pages) that shows an affected monitor are emailed automatically when a window is within about a day away, so they hear about planned work before it starts. Recurring windows notify subscribers ahead of each occurrence.
