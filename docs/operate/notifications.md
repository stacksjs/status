---
title: Notifications
description: Route UptimeStatus alerts to ten channels per monitor, with issue-vs-down severity and escalation.
---

# Notifications

When an [incident](/operate/incidents) opens or resolves, UptimeStatus notifies the people who need to know. Notifications are configured per monitor, so a critical production API can page on-call while a staging site only emails.

## Supported channels

UptimeStatus ships ten notification channels out of the box:

- **Email**
- **SMS**
- **Slack**
- **Discord**
- **Microsoft Teams**
- **PagerDuty**
- **Opsgenie**
- **Pushover**
- **ntfy**
- **Webhook**

Each channel stores its own credentials (a Slack webhook URL, a PagerDuty routing key, an ntfy topic, and so on) and can be reused across many monitors.

## Attaching channels to a monitor

1. Open the monitor in the dashboard, find the **Alert routing** card, and pick a channel to attach.
2. For each attachment, choose which severities it fires on: `down` only, `issue` only, or `both` (the default). You can change this per attachment at any time from the same card.

This severity filter is the core of a sane alerting setup: page the whole team on `down`, but route soft `issue` events (slow responses, SSL or domain expiring soon, DNS drift, blocklistings) to a quieter channel like email or a Slack room. A down-only channel stays silent for those issue events, and an issue-only channel stays silent for hard outages.

## Escalation

Escalation is driven by incident state. When an incident opens it fires the attached channels immediately. If no one **acknowledges** it, higher-tier channels (PagerDuty, Opsgenie) keep escalating according to their own on-call policy — UptimeStatus hands off the incident and lets the pager provider manage rotations. Acknowledging the incident stops repeat pages; resolving it (or an automatic recovery) sends the all-clear.

## Webhook payload

The generic **Webhook** channel POSTs a JSON body to your endpoint, so you can wire UptimeStatus into anything. An incident notification carries structured `event`, `monitor`, and `incident` objects alongside the human-readable `subject`/`message`:

```json
{
  "event": "incident.opened",
  "severity": "critical",
  "subject": "🔴 API is down",
  "message": "A uptime check failed for https://api.example.com/health.",
  "monitor": {
    "id": 42,
    "name": "API",
    "url": "https://api.example.com/health"
  },
  "incident": {
    "id": 1087,
    "status": "investigating",
    "started_at": "2026-07-06T14:22:05Z"
  }
}
```

- `event` is `incident.opened` when an incident opens and `incident.resolved` when it clears (the resolved payload carries `incident.status: "resolved"`).
- `severity` is `critical` for a hard down, `warning` for a soft issue (slow response, SSL expiring, DNS drift), and `info` for a recovery.
- `incident.status` is one of `investigating`, `identified`, `monitoring`, or `resolved`.

Standalone notices that are not tied to an incident (an SSL expiry warning, a domain-expiry reminder) omit the `event`, `monitor`, and `incident` objects and send just `subject`, `message`, and `severity`.
