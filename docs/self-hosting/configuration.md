---
title: Configuration
description: The environment variables and config files that drive a self-hosted UptimeStatus instance.
---

# Configuration

UptimeStatus is configured in two layers: a `.env` file for secrets and per-environment values, and typed files in the `config/` directory for structured, version-controlled defaults.

## The `config/` directory

Everything the app can be tuned with lives in `config/` as typed TypeScript modules — `database.ts`, `email.ts`, `queue.ts`, `notification.ts`, `realtime.ts`, `regions.ts`, `sso.ts`, and more. Each file exports a strongly-typed object with sensible defaults, and most values read from an environment variable so you rarely edit the config files directly for a deploy — you set env vars and let the config pick them up. Edit a `config/*.ts` file when you want to change a *default* or a piece of structure (say, the list of notification channels); set an env var when you want to change a *value* for one deployment.

## Key environment variables

Copy `.env.example` to `.env` and set at least these:

| Variable | Purpose |
|---|---|
| `APP_DOMAIN` | The hostname the app is served from (e.g. `status.example.com`). Used for links, cookies, and custom-domain resolution. |
| `APP_KEY` | Encryption key for sessions and encrypted env values. Generate a fresh one per install. |
| `DB_CONNECTION` | `sqlite` (default) or `postgres`. |
| `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` | Database connection (Postgres). |
| `QUEUE_DRIVER` | `sync` (dev only), `database`, or `redis` (recommended for production). |
| `REDIS_URL` | Redis endpoint when `QUEUE_DRIVER=redis`. |
| `MAIL_MAILER` | Mail driver: `ses`, `smtp`, or `log`. See [Sending email via SES](/features/email-ses). |
| `MAIL_FROM_ADDRESS` / `MAIL_FROM_NAME` | Default sender identity for outbound mail. |
| `WORKER_REGION` | Region label stamped on check results (default `default`). |
| `MONITOR_REGIONS` | Comma-separated regions consensus considers. See [Scaling](/self-hosting/scaling). |
| `BROADCAST_PORT` | WebSocket port for the realtime broadcaster. |

## Notification provider keys

Each [notification channel](/operate/notifications) reads its credentials from the environment or from the channel record stored per team — for example a Slack webhook URL, a PagerDuty routing key, a Pushover token, or an ntfy topic. Store provider secrets as encrypted env values with `buddy env:set … --file .env.production` so they never sit in plaintext.

## SSO

Social and enterprise sign-in is configured in `config/sso.ts` with the provider client IDs and secrets (Google, Apple, GitHub) supplied via env vars. Leave a provider's keys unset to disable it — the corresponding login button simply won't render.

## Secrets

Never commit real secrets. Keep them in `.env` (git-ignored) or, for production, encrypt them with `buddy env:set`. The [deploy guide](/self-hosting/deploy) walks through first-time setup.
