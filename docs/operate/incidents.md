---
title: Incident management
description: How UptimeStatus opens, acknowledges, and resolves incidents automatically when a monitor check fails.
---

# Incident management

UptimeStatus turns raw check failures into a human-readable timeline. When a monitor's check fails, an incident opens automatically — you don't file it by hand — and every state change from that point is recorded so you can see exactly what happened and when.

## The incident lifecycle

Incidents move through three states:

- **Open** — a check failed and consensus (see below) agrees the monitor is down or degraded. The incident is created with a first timeline entry and any attached [notification channels](/operate/notifications) fire.
- **Acknowledged** — a responder has claimed the incident. Acknowledging silences repeat escalation but does not close the incident; it signals "someone is on it."
- **Resolved** — the monitor recovers (a subsequent check passes) or a responder resolves it manually. UptimeStatus stamps the resolve time, which fixes the incident's total duration.

```
open ──▶ acknowledged ──▶ resolved
  │                          ▲
  └──────────────────────────┘   (auto-resolve on recovery)
```

Recovery is automatic: once the monitor passes its check again, the open incident resolves itself and a recovery notification is sent.

## Issue vs. down severity

Not every failure is an outage. UptimeStatus distinguishes two severities:

- **Down** — the target is unreachable or returned a failing status. This is a hard outage.
- **Issue** — the target responded, but something is degraded: a slow response, an SSL certificate nearing expiry, a DNS record drift, or a soft-failing health check.

Severity flows through to routing — you can page on `down` but only email on `issue` — and to the public status page.

## Consensus keeps incidents honest

A single probe location can't tell "the target is down" from "our one probe lost its route." UptimeStatus evaluates cross-region agreement before opening an incident, so a single region's blip never pages anyone. See [Scaling & multi-region](/self-hosting/scaling) for how this works.

## Incidents drive status-page state

Open incidents are what a [status page](/operate/status-pages) reflects. A monitor mapped to a status-page component shows that component as degraded or down for the life of the incident, and the incident timeline can be published so subscribers see updates as they land.
