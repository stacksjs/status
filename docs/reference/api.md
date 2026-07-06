---
title: API reference
description: Query monitors, incidents, and status over the same-origin JSON API exposed by UptimeStatus.
---

# API reference

UptimeStatus exposes a JSON API (built on [bun-router](https://github.com/stacksjs/router)) for reading monitors, incidents, and status programmatically. The API is served **same-origin under `/api`** — on a self-host that's `https://<your-domain>/api`, and on managed hosting it's `https://uptime-status.org/api`.

## Authentication

Requests authenticate with a **bearer token**. Create a token in the dashboard under **Settings → API tokens**, then send it in the `Authorization` header:

```
Authorization: Bearer <your-token>
```

Tokens are scoped to your team, so the API only ever returns data for the team that owns the token. Requests without a valid token receive `401 Unauthorized`.

## Endpoints

### List monitors

Returns every monitor in the team, with current status and last-check metadata.

```bash
curl -s https://uptime-status.org/api/monitors \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": [
    {
      "id": 42,
      "name": "API — api.example.com",
      "url": "https://api.example.com/health",
      "status": "up",
      "uptime_percentage": 99.98,
      "last_checked_at": "2026-07-06T14:21:00Z"
    }
  ]
}
```

### Get a monitor

Fetch a single monitor by id, including its recent check results.

```bash
curl -s https://uptime-status.org/api/monitors/42 \
  -H "Authorization: Bearer $TOKEN"
```

### List incidents

Returns [incidents](/operate/incidents) across the team's monitors. Filter by state or monitor with query parameters.

```bash
curl -s "https://uptime-status.org/api/incidents?status=open" \
  -H "Authorization: Bearer $TOKEN"
```

```json
{
  "data": [
    {
      "id": 1087,
      "monitor_id": 42,
      "severity": "down",
      "status": "open",
      "started_at": "2026-07-06T14:22:05Z",
      "resolved_at": null
    }
  ]
}
```

## Conventions

- Endpoints are **RESTful**: collections at `/api/{resource}`, single records at `/api/{resource}/{id}`.
- Responses wrap records in a top-level `data` key; list endpoints paginate.
- All timestamps are ISO 8601 in UTC.

For push-based integration (receiving events instead of polling), attach a **Webhook** [notification channel](/operate/notifications) to a monitor.
