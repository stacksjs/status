---
title: DNS Blocklist Monitoring
description: Watch your true origin IP against public spam and abuse blocklists so a listing never silently kills your email or traffic.
---

# DNS Blocklist Monitoring

If your server's IP lands on a public spam or abuse blocklist (DNSBL), your email stops getting delivered and some networks start dropping your traffic — usually without any error you'd notice. Blocklist monitoring checks your **true origin IP** against dozens of well-known lists and alerts you the moment you're listed.

## How it works

On each run the checker resolves your **origin IP** — the real server address, not the CDN or proxy edge in front of it — and queries a curated set of public DNSBLs (spam, abuse, and policy lists). For each list it records **listed / not listed** and, where provided, the **reason** and the **delisting URL**.

Checking the origin matters: a blocklisting is about the machine actually sending mail or serving traffic, so testing the CDN edge would miss the problem entirely. Checks run on a regular cadence.

## What triggers an alert

- Your origin IP is **newly listed** on one or more monitored blocklists.
- A listing **persists** across runs (so you're reminded until it's resolved).

The monitor clears automatically once every list reports your IP as delisted again.

## Setting it up

1. **Add monitor** and choose **DNS Blocklist**.
2. Enter your **origin IP** (or the hostname to resolve to it). If your site sits behind a CDN, use the address of the box that actually sends mail / serves origin traffic.
3. Review the **blocklists** to watch (a sensible default set is preselected).
4. Set the **check interval**.
5. Attach **notifications** — route to whoever owns deliverability.

> When you're listed, use the delisting link the monitor surfaces to request removal, then fix the root cause (compromised account, misconfigured mail server, or shared-IP reputation) before it recurs.

## Related

- [DNS](/monitors/dns) · [Domains](/monitors/domains) · [Port Scan](/monitors/port-scan)
- [Notifications](/operate/notifications)
- Marketing: [DNS blocklist monitoring feature](https://uptime-status.org/features/blocklist-monitoring)
