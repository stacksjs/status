---
title: Notifications
description: Route UptimeStatus alerts to ten channels per monitor, with issue-vs-down severity and escalation.
---

# Notifications

When an [incident](/operate/incidents) opens, acknowledges, or resolves, UptimeStatus notifies the people who need to know. Notifications are configured per monitor, so a critical production API can page on-call while a staging site only emails.

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

1. Open the monitor in the dashboard and go to its **Notifications** tab.
2. Pick one or more channels to attach.
3. For each attachment, choose which severities it fires on — **down** only, **issue** only, or both.

This severity filter is the core of a sane alerting setup: page the whole team on `down`, but route soft `issue` events (slow responses, SSL expiring soon, DNS drift) to a quieter channel like email or a Slack room.

## Escalation

Escalation is driven by incident state. When an incident opens it fires the attached channels immediately. If no one **acknowledges** it, higher-tier channels (PagerDuty, Opsgenie) keep escalating according to their own on-call policy — UptimeStatus hands off the incident and lets the pager provider manage rotations. Acknowledging the incident stops repeat pages; resolving it (or an automatic recovery) sends the all-clear.

## Webhook payload

The generic **Webhook** channel POSTs a JSON body to your endpoint on every event, so you can wire UptimeStatus into anything:

```json
{
  "event": "incident.opened",
  "severity": "down",
  "monitor": {
    "id": 42,
    "name": "API — api.example.com",
    "url": "https://api.example.com/health"
  },
  "incident": {
    "id": 1087,
    "status": "open",
    "started_at": "2026-07-06T14:22:05Z"
  },
  "region_votes": { "eu-central": "down", "us-east": "down" }
}
```

The same payload shape is sent for `incident.acknowledged` and `incident.resolved`, with the relevant timestamps filled in.
