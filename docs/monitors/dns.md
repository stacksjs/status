---
title: DNS Monitoring
description: Snapshot your A, AAAA, MX, TXT, NS, and CAA records and get alerted the instant any of them change.
---

# DNS Monitoring

DNS is the control plane for your whole domain — one wrong record can reroute traffic, break email, or open the door to a takeover. DNS monitoring snapshots your records and alerts you the moment any of them change, whether the change was intentional or not.

## How it works

On each run the checker resolves a defined set of record types for your domain and compares the results to the last-known snapshot. Tracked types:

- **A** / **AAAA** — IPv4 / IPv6 addresses
- **MX** — mail exchangers
- **TXT** — SPF, DKIM, verification tokens
- **NS** — delegation / nameservers
- **CAA** — which CAs may issue certificates

When the resolved set differs from the stored snapshot, the monitor records a **diff** and alerts. Checks run on a regular cadence and query authoritative resolvers to avoid stale caches.

An example record diff on a change:

```diff
  example.com  A     93.184.216.34
- example.com  MX    10 mail.example.com
+ example.com  MX    10 mail.newprovider.net
+ example.com  TXT   "v=spf1 include:newprovider.net ~all"
```

## What triggers an alert

- **Any tracked record is added, removed, or modified** versus the snapshot.
- A record type you expected returns **NXDOMAIN** or an empty set.
- **NS delegation** changes — often the first sign of a domain takeover.

After you review a change, accept the new snapshot as the baseline so it stops alerting.

## Setting it up

1. **Add monitor** and choose **DNS**.
2. Enter the domain and select the **record types** to watch.
3. UptimeStatus captures the initial **baseline snapshot**.
4. Set the **check interval**.
5. Attach **notifications**.

## Related

- [Domains](/monitors/domains) · [SSL](/monitors/ssl) · [DNS Blocklist](/monitors/dns-blocklist)
- [Notifications](/operate/notifications)
- Marketing: [DNS monitoring feature](https://uptime-status.org/features/dns-monitoring)
