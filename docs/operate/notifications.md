---
title: Notifications
description: Route StatusHQ alerts to ten channels per monitor, with issue-vs-down severity and escalation.
---

# Notifications

When an [incident](/operate/incidents) opens or resolves, StatusHQ notifies the people who need to know. Notifications are configured per monitor, so a critical production API can page on-call while a staging site only emails.

## Supported channels

StatusHQ ships ten notification channels out of the box:

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

## Adding a channel

Channels live at the team level, under **Settings → Notifications**. Give the channel a name you'll recognise, pick its type, and fill in the fields that appear — the form asks for exactly what that type needs and tells you where to find it:

| Channel | What to paste | Where to get it |
| --- | --- | --- |
| Email | Email address | — |
| SMS | Phone number, with country code | — |
| Slack | Incoming webhook URL | Slack → Apps → Incoming Webhooks → Add to Slack |
| Discord | Webhook URL | Server Settings → Integrations → Webhooks → New Webhook |
| Microsoft Teams | Incoming webhook URL | The channel's ⋯ menu → Connectors → Incoming Webhook |
| PagerDuty | Integration key | Services → your service → Integrations → Events API v2 |
| Opsgenie | API key | Teams → your team → Integrations → API |
| Pushover | User key + application API token | Your Pushover dashboard, then Create an Application |
| ntfy | Topic (and optionally a self-hosted server URL) | Any topic name you subscribe to in the app |
| Webhook | Endpoint URL, plus optional JSON headers | Your own service |

Use **Send test** on the channel afterwards. It dispatches through the same job a real incident uses, so a test that arrives proves the credentials work.

## Routing alerts to a monitor

Open the monitor and find the **Alert routing** card. It shows what this monitor currently alerts — each routed channel and the severities it fires on — so you can read who gets paged without opening anything.

To change it, click **Manage alerts**. The dialog lists every channel your team has:

1. Tick the channels this monitor should alert.
2. For each, choose which severities it fires on: `down` only, `issue` only, or `both` (the default).
3. **Save routing** — one submit applies the whole grid.

Unticking a channel stops it alerting for that monitor; the channel itself stays available for others. A monitor with nothing ticked notifies no one, and the card says so in red.

This severity filter is the core of a sane alerting setup: page the whole team on `down`, but route soft `issue` events (slow responses, SSL or domain expiring soon, DNS drift, blocklistings) to a quieter channel like email or a Slack room. A down-only channel stays silent for those issue events, and an issue-only channel stays silent for hard outages.

## Escalation

Escalation is driven by incident state. When an incident opens it fires the attached channels immediately. If no one **acknowledges** it, higher-tier channels (PagerDuty, Opsgenie) keep escalating according to their own on-call policy — StatusHQ hands off the incident and lets the pager provider manage rotations. Acknowledging the incident stops repeat pages; resolving it (or an automatic recovery) sends the all-clear.

## Webhook payload

The generic **Webhook** channel POSTs a JSON body to your endpoint, so you can wire StatusHQ into anything. An incident notification carries structured `event`, `monitor`, and `incident` objects alongside the human-readable `subject`/`message`:

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
