---
title: UptimeStatus Documentation
description: Open-source uptime, SSL, DNS, and status-page monitoring. Self-hosted, or fully managed by us.
layout: home
hero:
  name: UptimeStatus
  text: Know the moment something breaks.
  tagline: Open-source uptime, SSL, DNS, and status-page monitoring — self-hosted, or fully managed by us.
  actions:
    - theme: brand
      text: Quick start
      link: /getting-started
    - theme: alt
      text: Open the dashboard
      link: https://uptime-status.org/dashboard
    - theme: alt
      text: View on GitHub
      link: https://github.com/stacksjs/status
features:
  - title: Availability
    icon: 📡
    details: HTTP, ping, TCP, cron heartbeats, and JSON health checks — from multiple regions, as often as every 30 seconds.
  - title: Certificates & DNS
    icon: 🔒
    details: SSL expiry and fingerprint changes, WHOIS domain expiry, DNS-record drift, and origin-IP blocklist watches.
  - title: Performance & security
    icon: ⚡
    details: Response-time trends, scheduled Lighthouse audits, broken-link crawls, port-scan detection, and AI checks.
  - title: Status pages
    icon: 🟢
    details: Public or access-controlled pages on your own domain, with uptime history, subscribers, and no vendor watermark.
  - title: Incidents & alerts
    icon: 🔔
    details: Failed checks open a timeline incident automatically and page you across ten notification channels.
  - title: Self-hostable
    icon: 🧰
    details: MIT-licensed and self-hostable on a single box — or let the UptimeStatus team run it for you.
---

## Get monitoring in four steps

1. **Create your account.** [Sign up free](https://uptime-status.org/register) — 5 monitors, no card — or [self-host](/self-hosting/deploy) the whole thing from the repo.
2. **Add your first monitor.** Point a monitor at a URL, host, or port. [Uptime](/monitors/uptime), [SSL](/monitors/ssl), [DNS](/monitors/dns), [ping](/monitors/ping) and more each become a check on that site.
3. **Route your alerts.** Attach [Email, SMS, Slack, Discord, Teams, PagerDuty, and more](/operate/notifications) to a monitor.
4. **Publish a status page.** Give customers a [public or access-controlled page](/operate/status-pages) that reflects your monitors in real time.

## Explore the docs

- **[Monitors overview](/monitors/)** — every check type, grouped by what it watches.
- **[Notifications](/operate/notifications)** — ten channels, routed per monitor, with issue-vs-down severity.
- **[Status pages](/operate/status-pages)** — branded pages on your own domain.
- **[Self-hosting](/self-hosting/deploy)** — deploy and run UptimeStatus yourself.
- **[CLI](/reference/cli)** and **[API](/reference/api)** — automate everything.
