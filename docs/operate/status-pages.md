---
title: Status pages
description: Publish public or access-controlled status pages with custom domains, subscribers, component groups, and your own branding.
---

# Status pages

A status page is the public face of your monitoring. UptimeStatus lets each team publish one or more pages that reflect the live state of their monitors, complete with incident history, uptime bars, and your own branding — with **no vendor watermark on any plan**.

## Public or access-controlled

A page can be:

- **Public** — anyone with the link sees it. Ideal for a customer-facing `status.example.com`.
- **Access-controlled** — gated behind a password or team membership, for internal-only dashboards.

## Custom domains

By default a page is served at `/status/{slug}`. To serve it from your own hostname:

1. Set the page's **custom domain** (e.g. `status.acme.com`).
2. Add a **CNAME** record for that hostname pointing at your UptimeStatus deployment.

TLS for the custom domain is terminated by your reverse proxy or load balancer for the additional hostname. On a request, UptimeStatus matches the incoming `host` against each page's custom domain and renders that team's page.

## How monitors map to components

A status page is built from **components** — the rows a visitor sees ("API", "Website", "Database"). Each component is backed by one or more monitors:

- A component's state is derived from its monitors' [incidents](/operate/incidents): all-good when every monitor is up, **degraded** on an `issue`, **down** on an outage.
- Group related components into **component groups** (e.g. "US Region", "EU Region") to keep a large page readable.

## Uptime-history bars

Each component shows an **uptime-history bar** — a strip of daily up/down segments over a rolling window (up to 90 days) with the computed uptime percentage. [Maintenance windows](/operate/maintenance) are excluded from that percentage so planned work never dents your numbers. The bars are cached with a short TTL so a busy public page stays fast.

## Subscribers

Visitors can **subscribe** to a page to be notified when incidents are posted or resolved. Subscriptions are per page, so a customer only hears about the services they care about.

## Branding

Make the page yours: add a **logo** (by URL), set an **accent color** for the top bar, and (on a custom domain) drop the URL prefix entirely. Both live under the status page's **Branding** card in the dashboard. There is no UptimeStatus watermark on any plan.

Status pages are powered by the same realtime layer as the dashboard, so a monitor going down updates the page in place — see the [live status](/features/live-status) source for how the broadcaster works.
