---
title: Quick start
description: Create an account, add your first monitor, route alerts, and publish a status page in a few minutes.
---

# Quick start

You can be monitoring your first site in under two minutes. This walks through
the four things every new account does, in order.

## 1. Create your account

[Sign up free](https://uptime-status.org/register) — 5 monitors, no credit card.
Prefer to run it yourself? Follow [Self-hosting → Deploy](/self-hosting/deploy)
and you get the same product with no limits.

## 2. Add your first monitor

From the dashboard, choose **Add monitor** and pick a type:

1. Select the check type — [Uptime](/monitors/uptime) is the most common.
2. Enter the target (a URL like `https://example.com`, a host, or `host:port`).
3. Set the **check interval** (down to every 30 seconds) and, for HTTP, any
   [assertions](/monitors/uptime) — expected status code or a keyword that must
   appear in the response.
4. Save. The monitor starts checking immediately and its uptime-history bars
   begin to fill in.

Monitors for the same domain are grouped into a **site**, so adding an
[SSL](/monitors/ssl) and a [DNS](/monitors/dns) check for `example.com` gives you
one rolled-up view of that site's health.

## 3. Route your alerts

A monitor is only useful if it can reach you. Open the monitor's
**Notifications** tab and attach one or more channels:

- Email, SMS, and phone
- Slack, Discord, Microsoft Teams
- PagerDuty, Opsgenie, Pushover, ntfy
- Any webhook

Channels are routed **per monitor** with issue-vs-down severity, so a slow
response can ping Slack while a hard outage pages on-call. See
[Notifications](/operate/notifications).

## 4. Publish a status page

Give customers a page that reflects your monitors in real time:

1. Create a [status page](/operate/status-pages) and add the monitors (or
   component groups) it should show.
2. Point a `CNAME` like `status.yourcompany.com` at UptimeStatus and set it as
   the custom domain.
3. Add your logo and accent color. There's no vendor watermark on any plan.

Public visitors see live status, uptime history, and any open
[incidents](/operate/incidents) — and can subscribe for updates.

## Next steps

- Browse every check type in the [Monitors overview](/monitors/).
- Schedule [maintenance windows](/operate/maintenance) so planned work doesn't page you.
- Automate with the [CLI](/reference/cli) and [API](/reference/api).
