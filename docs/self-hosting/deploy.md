---
title: Self-hosting & deploy
description: Deploy your own UptimeStatus instance — MIT-licensed, self-hostable, and running on a single box behind a reverse proxy.
---

# Self-hosting & deploy

UptimeStatus is **MIT-licensed and fully self-hostable**. The entire application — web dashboard, JSON API, check workers, and scheduler — is open source at [github.com/stacksjs/status](https://github.com/stacksjs/status). You can run it on hardware you control, or let the UptimeStatus team run it for you (see below).

## Requirements

- **Bun >= 1.3**
- A reverse proxy (Caddy, nginx, or similar) to terminate TLS
- A database (SQLite is fine to start; Postgres for scale) and optionally Redis for the queue

## Deploy in five steps

```bash
# 1. Clone the repo
git clone https://github.com/stacksjs/status.git
cd status

# 2. Install dependencies
bun install

# 3. Configure your environment
cp .env.example .env
# edit .env — see Configuration for the vars that matter

# 4. Create the schema
./buddy migrate

# 5. Ship it
./buddy deploy
```

See the [Configuration](/self-hosting/configuration) page for the environment variables to set, and the [CLI reference](/reference/cli) for what each `buddy` command does.

## What runs on the box

For most self-hosters, a **single box** runs everything, behind a reverse proxy that terminates TLS and forwards to the app:

- **web + API** — `buddy serve`, the dashboard and the [JSON API](/reference/api).
- **worker** — `buddy queue:work`, which executes the checks that flip monitor status.
- **scheduler** — `buddy schedule:run`, which dispatches due checks every minute.
- **realtime** (optional) — `buddy realtime`, the WebSocket broadcaster for live status dots.

This single-box layout comfortably handles a real monitoring workload. When you outgrow it — more monitors, or a second geographic check region — see [Scaling & multi-region](/self-hosting/scaling), which explains how to split the worker onto its own hosts and add regions without touching the primary.

## Fully-managed alternative

If you'd rather not operate the box yourself, the UptimeStatus team offers **fully-managed hosting** at [uptime-status.org](https://uptime-status.org) — the same open-source application, run and updated for you, with multi-region checks already provisioned. Self-hosting and managed hosting run identical code, so you can move between them without changing how you use the product.
