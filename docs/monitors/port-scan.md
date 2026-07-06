---
title: Port-Scan Monitoring
description: Detect newly exposed ports on your servers so an accidental firewall change or leaky service is caught fast.
---

# Port-Scan Monitoring

Every open port is attack surface. A misconfigured firewall rule, a debug service left listening, or a container that published a port it shouldn't have — these expose your infrastructure quietly. Port-scan monitoring snapshots which ports are open on a host and alerts you when a **new** one appears.

## How it works

On each run the scanner probes a defined range of TCP ports on your target host and records which are **open**, **closed**, or **filtered**. It compares the open-port set to the last-known snapshot and reports the diff. For each open port it notes the port number and, where it can, the likely service.

An example diff when a new port appears:

```diff
  22/tcp    open   ssh
  443/tcp   open   https
+ 6379/tcp  open   redis        <-- newly exposed
+ 9000/tcp  open   unknown      <-- newly exposed
```

Scans run on a regular cadence (a full scan is heavier than a single check, so not every 30s). You define the **port range** to keep scans fast and focused.

## What triggers an alert

- A **previously closed port is now open** — the primary signal.
- The **service on a known port changes** unexpectedly.
- A port you expected to be open is now **closed/filtered** (optional, catches unintended service outages).

After you review a change, accept the new snapshot as the baseline.

## Setting it up

1. **Add monitor** and choose **Port Scan**.
2. Enter the host and the **port range** to scan (e.g. `1–1024` plus any app ports).
3. UptimeStatus captures the **baseline** of currently-open ports.
4. Set the **scan interval**.
5. Attach **notifications** — route these to your security/ops channel.

> Only scan hosts you own or are authorized to test. Keep ranges tight so scans stay fast and don't trip your own intrusion-detection tooling.

## Related

- [TCP Port](/monitors/tcp-port) · [DNS Blocklist](/monitors/dns-blocklist) · [Server Metrics](/monitors/server-metrics)
- [Notifications](/operate/notifications)
- Marketing: [Port-scan monitoring feature](https://uptime-status.org/features/port-scan-monitoring)
