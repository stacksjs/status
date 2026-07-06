---
title: CLI reference (buddy)
description: The buddy commands you use to run, migrate, and deploy a UptimeStatus instance.
---

# CLI reference (buddy)

`buddy` is the [Stacks](https://stacksjs.org) CLI that ships with UptimeStatus. You invoke it as `./buddy <command>` from the project root. This page covers the commands relevant to operating an instance; run `./buddy --help` for the full list.

## `buddy serve`

Starts the web dashboard and the [JSON API](/reference/api). This is the process a reverse proxy forwards traffic to.

```bash
./buddy serve
```

## `buddy migrate`

Applies pending database migrations, creating or updating the schema. Run it after cloning and on every deploy that ships schema changes.

```bash
./buddy migrate
```

## `buddy queue:work`

Runs a queue worker — the process that actually executes monitor checks and sends [notifications](/operate/notifications). Scope a worker to a queue so checks and alerts scale independently:

```bash
./buddy queue:work --queue=checks
./buddy queue:work --queue=notifications
```

Use `buddy queue:status` to watch queue depth. See [Scaling & multi-region](/self-hosting/scaling) for how to run multiple worker pools.

## `buddy schedule:run`

Runs the scheduler tick, which dispatches due checks every minute and, on the primary, evaluates cross-region consensus. Run **one** scheduler per deployment — additional regions only need workers, not a scheduler.

```bash
./buddy schedule:run
```

## `buddy deploy`

Builds and ships the application to your target. On a self-hosted box this provisions services and runs `buddy migrate` as part of the flow.

```bash
./buddy deploy
```

See the [deploy guide](/self-hosting/deploy) for first-time setup.

## `buddy dev`

Starts the local development server with hot reload — use this while working on the app locally, not in production.

```bash
./buddy dev
```

## Related

- `buddy realtime` — the WebSocket broadcaster that powers [live status](/features/live-status).
- `buddy env:set … --file .env.production` — store an encrypted env value (provider secrets, ingest tokens). See [Configuration](/self-hosting/configuration).
