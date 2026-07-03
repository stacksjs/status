# Status

[![GitHub Actions](https://img.shields.io/github/actions/workflow/status/stacksjs/status/ci.yml?style=flat-square&branch=main)](https://github.com/stacksjs/status/actions?query=workflow%3Aci)
[![License](https://img.shields.io/github/license/stacksjs/status?style=flat-square)](LICENSE.md)
[![Discord](https://img.shields.io/discord/1039191667654455337?style=flat-square&label=discord)](https://discord.gg/stacksjs)

A self-hostable **status page and uptime monitoring platform** — the same category as [Oh Dear](https://ohdear.app), [OpenStatus](https://github.com/openstatusHQ/openstatus), and Better Stack, built entirely as a [Stacks](https://github.com/stacksjs/stacks) app: `defineModel()` for schema, stx for views, `app/Jobs` + a cron-style scheduler for background checks, and `buddy` for everything else.

> [!NOTE]
> Status is under active development. [stacksjs/status#1](https://github.com/stacksjs/status/issues/1) is the single source of truth for scope — every feature below is tracked there with its implementation status, and it's where new feature ideas get triaged before landing.

## What it does

**Monitoring** — one `Monitor` model, many check types, all scheduled and run as background jobs:

- HTTP uptime, with a structured assertion DSL (status code / header / body / response-time, `eq`/`contains`/`gt`/… ) instead of loose keyword matching
- SSL/TLS certificate expiry & fingerprint-change detection
- DNS record snapshotting & diffing (A/AAAA/MX/TXT/NS/CAA)
- Domain (WHOIS) expiry tracking
- Application health endpoints (a structured JSON contract, not just a 200)
- Heartbeat / cron monitoring — a ping URL your scheduled job calls, alerting on a missed check-in
- Ping & raw TCP port checks
- Full-site crawling for broken links, mixed content, and sitemap drift
- Lighthouse audits (performance/accessibility/SEO/best-practices) with trend regression alerts
- Port scanning (expected vs. unexpected open ports)
- DNS blocklist (DNSBL) monitoring across public spam-block zones
- Natural-language AI checks — describe what a page should show, get a pass/fail

**Incidents & reliability** — automatic incident open/resolve on every check transition, exponential backoff so a monitor stuck down isn't hammered forever, per-region check tagging for multi-region deployments, and a self-check job (`CheckWorkerHealth`) that answers "who monitors the monitor?" via an optional external dead-man's-switch.

**Notifications** — email, SMS, Slack, Discord, Teams, PagerDuty, Opsgenie, Pushover, ntfy, and generic webhooks, all behind one `NotificationChannel.send()` so adding a new channel type is a small diff. Plus a separate outbound webhook stream (HMAC-signed) for "any check result" so customers can build their own integrations.

**Status pages** — public pages with:

- Custom domains (a customer CNAMEs their own domain, served with no visible redirect)
- Access control — password-protected, email-domain-restricted, or IP-allowlisted, on top of plain public/private
- Component groups (organize monitors into named sections like "API", "Database")
- Scheduled maintenance windows, rendered distinctly from incidents
- Manually-authored status reports/announcements, distinct from automated incidents
- Subscriber notifications (email) and an RSS/Atom incident feed
- Locale (`<html lang>`) and forced light/dark theme fields

**Teams & billing** — team invites with owner/admin/member roles, and usage limits (monitor count, check-interval floor, status page count) enforced per plan, resolved from the team owner's subscription.

**API** — full CRUD generated per model (`useApi`), plus hand-written custom actions where the generated surface isn't enough (on-demand checks, incident acknowledgement, team invites, status-page unlock). Personal access tokens for API auth ship with the framework.

## Prerequisites

Status runs on [Bun](https://bun.sh) — no Node.js required.

- **Bun ≥ 1.3.11** — `curl -fsSL https://bun.sh/install | bash`
- **macOS, Linux, or WSL**
- SQLite out of the box for local development; Postgres/MySQL for production (see `.env.example`)

## Get started

```bash
git clone https://github.com/stacksjs/status.git
cd status
bun install
cp .env.example .env
./buddy key:generate
./buddy migrate
./buddy dev
```

`./buddy dev` starts the frontend (status pages, dashboard), API, and dependent dev servers together. See `.env.example` for every configurable option — database connection, queue driver, notification-channel credentials, `WORKER_REGION`/`WORKER_HEARTBEAT_URL` for multi-region/self-check deployment, and so on.

## Architecture notes

- **Models are the source of truth.** Every table is generated from `app/Models/*.ts` via `./buddy generate:migrations` — migrations are never hand-written.
- **Checks are jobs.** `app/Jobs/Run*Check.ts`, fanned out every minute by `DispatchDueChecks` (`app/Scheduler.ts`). See [docs/features/multi-region-and-scaling.md](docs/features/multi-region-and-scaling.md) for how to scale worker throughput and run checks from more than one region.
- **Status pages are stx views**, not a separate frontend app — `resources/views/status/[slug].stx` (path-based) and `resources/views/index.stx` (custom-domain resolution, since this router's static views take priority over programmatic routes at the same path).
- **Queue driver matters in production.** `sync` is dev-only; `redis` is recommended for real deployments (distributed locking, safe horizontal worker scaling). See `config/queue.ts`.

## Contributing

This repo tracks scope in [stacksjs/status#1](https://github.com/stacksjs/status/issues/1) — check there before starting on something to avoid duplicate work. Framework-level bugs found along the way get fixed upstream in [stacksjs/stacks](https://github.com/stacksjs/stacks), [stacksjs/stx](https://github.com/stacksjs/stx), and [stacksjs/bun-query-builder](https://github.com/stacksjs/bun-query-builder), not worked around locally.

Small, conventional commits (`feat:`, `fix:`, `chore:`, …) per logical unit.

## Community

[Discussions on GitHub](https://github.com/stacksjs/status/discussions) · [Stacks Discord](https://discord.gg/stacksjs)

## Credits

Built on [Stacks](https://github.com/stacksjs/stacks). Feature ideas cross-referenced against [Oh Dear](https://ohdear.app) and [OpenStatus](https://github.com/openstatusHQ/openstatus) (AGPL-3.0 — reviewed for concepts only; no code reuse, this app stays MIT).

## License

The MIT License (MIT). Please see [LICENSE.md](LICENSE.md) for more information.
