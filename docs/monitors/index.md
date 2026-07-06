---
title: Monitors
description: An overview of UptimeStatus monitor types and how sites group your checks across availability, certificates, DNS, performance, and security.
---

# Monitors

A **monitor** is a single check that runs on a schedule and tells you whether one specific thing is healthy. UptimeStatus groups related monitors under a **site** — a site is the thing you care about (an app, an API, a marketing page), and it can hold many monitors at once.

That means one site can have an [Uptime](/monitors/uptime) check on its homepage, a [Health Check](/monitors/health-checks) on its API, an [SSL](/monitors/ssl) check on its certificate, and a [DNS](/monitors/dns) check on its records — all reporting into the same place, the same incident timeline, and the same [status page](/operate/status-pages). Most monitors run from multiple regions with consensus, as often as every **30 seconds**, and every one can attach [notifications](/operate/notifications).

## Availability

Is it up and reachable right now?

- [Uptime](/monitors/uptime) — HTTP(S) checks with status-code, latency, and keyword assertions.
- [Ping](/monitors/ping) — ICMP reachability for hosts that don't speak HTTP.
- [TCP Port](/monitors/tcp-port) — confirm a port accepts connections (databases, SMTP, custom services).
- [Cron & Heartbeats](/monitors/cron-heartbeats) — watch scheduled jobs by expecting a ping on a cadence.
- [Health Checks](/monitors/health-checks) — fetch a JSON health endpoint and assert on individual fields.

## Certificates & DNS

Is the domain layer correct and not about to lapse?

- [SSL](/monitors/ssl) — certificate-expiry warnings at 30/14/7/1 days and fingerprint-change detection.
- [Domains](/monitors/domains) — WHOIS-based domain-registration expiry warnings.
- [DNS](/monitors/dns) — snapshot A/AAAA/MX/TXT/NS/CAA records and alert on any change.
- [DNS Blocklist](/monitors/dns-blocklist) — watch your true origin IP against public blocklists.

## Performance & security

Is it fast, well-built, and not leaking attack surface?

- [Performance](/monitors/performance) — track response-time trends and catch slow regressions.
- [Lighthouse](/monitors/lighthouse) — scheduled Lighthouse audits with score-regression alerts.
- [Broken Links](/monitors/broken-links) — crawl a site for broken links and mixed content.
- [Port Scan](/monitors/port-scan) — detect newly exposed ports on your servers.
- [Server Metrics](/monitors/server-metrics) — push CPU/RAM/disk telemetry from your box.
- [AI Checks](/monitors/ai-checks) — describe an assertion in plain language and let AI verify it.

## Next steps

1. Create a **site** for the thing you want to watch.
2. Add one or more monitors from the categories above.
3. Attach [notifications](/operate/notifications) and publish a [status page](/operate/status-pages).

Marketing: browse all [monitoring features](https://uptime-status.org/features).
