---
title: What is UptimeStatus
description: An overview of UptimeStatus — open-source uptime, SSL, DNS, and status-page monitoring, self-hosted or fully managed.
---

# What is UptimeStatus

UptimeStatus is an open-source monitoring platform. It watches your sites and
services around the clock — uptime, SSL certificates, domains, DNS, performance,
and more — opens incidents automatically when something breaks, pages you across
ten notification channels, and keeps your users informed with a status page on
your own domain.

It's [MIT-licensed](https://github.com/stacksjs/status) and built on the
[Stacks](https://stacksjs.org) framework. Run every feature yourself with no
limits, or let the UptimeStatus team host it for you.

## The model: sites, monitors, and checks

- **A monitor** is one thing you watch — a URL, a host, a port, a certificate, a
  DNS zone. Each monitor runs on an interval (as often as every 30 seconds) from
  one or more regions.
- **A site** groups the monitors for a single domain. Track `example.com` with an
  uptime check, an SSL check, and a DNS check, and the dashboard rolls them up
  into one site-level health status (worst check wins).
- **A check result** is a single observation — status, latency, and any
  assertion outcomes — recorded every run and used to compute uptime %, latency
  trends, and the uptime-history bars.

When enough consecutive checks fail, a monitor flips state and an
[incident](/operate/incidents) opens. Notifications fire, and any
[status page](/operate/status-pages) the monitor belongs to updates in real time.

## What you can monitor

- **Availability** — [Uptime](/monitors/uptime), [Ping](/monitors/ping),
  [TCP port](/monitors/tcp-port), [Cron & heartbeats](/monitors/cron-heartbeats),
  [Health checks](/monitors/health-checks).
- **Certificates & DNS** — [SSL](/monitors/ssl), [Domains](/monitors/domains),
  [DNS records](/monitors/dns), [DNS blocklists](/monitors/dns-blocklist).
- **Performance & security** — [Performance](/monitors/performance),
  [Lighthouse](/monitors/lighthouse), [Broken links](/monitors/broken-links),
  [Port scan](/monitors/port-scan), [Server metrics](/monitors/server-metrics),
  [AI checks](/monitors/ai-checks).

## Self-hosted or managed

Everything is the same code either way:

- **Self-host** — clone the repo and run it on a single box (web, API, worker, and
  scheduler behind a reverse proxy). See [Deploy](/self-hosting/deploy).
- **Managed** — sign up at [uptime-status.org](https://uptime-status.org/register)
  and we run it for you.

Ready to set up your first monitor? Head to the [Quick start](/getting-started).
