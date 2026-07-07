---
title: Live status
description: The dashboard monitor list updates a monitor's status, response time, and last-checked time in place over a WebSocket — no page reload.
---

# Live status

The dashboard's monitor list updates in place as checks run: a monitor's status dot, its latest response time, and its "last checked" time all change without a page reload. A monitor going down turns red the moment the check records it.

## How it works

- `buddy realtime` starts a **broadcaster**: a WebSocket server (the `bun` driver — native Bun WebSockets, no Redis or Pusher required) plus a short poll loop over the `monitors` table.
- When a monitor's status changes **or** a fresh check lands (its `last_checked_at` advances), the broadcaster emits a `monitor:updated` event — carrying the new status, the latest response time, and the check timestamp — on a per-team channel.
- The dashboard's monitor list subscribes over the WebSocket and updates the affected row's status dot, response-time cell, and last-checked label in place. The relative "last checked" label also ticks on its own so it stays fresh between checks. If the broadcaster is down or realtime is disabled, the page silently keeps its on-load snapshot — the whole thing is progressive enhancement.

The channel is keyed by the team's **uuid**, not its numeric id (`team.<uuid>.monitors`). That keeps the WebSocket server unauthenticated (no per-connection auth handshake) without letting a stranger watch a team's status feed by guessing a small integer — knowing the uuid is the capability. The dashboard hands the browser only its own team's uuid.

## Running it

Run the broadcaster alongside the web/API servers and the queue worker:

```bash
buddy serve          # web + API
buddy queue:work     # runs the checks that flip monitor status
buddy realtime       # the live-status broadcaster (this process)
```

Options:

- `--port <port>` — WebSocket port (defaults to `BROADCAST_PORT`, then `config.realtime.server.port`, then `6001`).
- `--interval <ms>` — poll interval (default `3000`). A monitor's change surfaces within roughly one interval.

The browser connects to `ws(s)://<app-host>:<BROADCAST_PORT>/ws`. Over TLS, put the broadcaster behind your reverse proxy as `wss` on the app host (the client uses `wss` automatically when the page is served over `https`).

Relevant env (see `config/realtime.ts`):

```bash
BROADCAST_PORT=6001      # WebSocket port
BROADCAST_HOST=0.0.0.0
BROADCAST_SCHEME=ws      # ws locally; wss behind a TLS proxy
```

## Scaling

One broadcaster serves every connected browser and reads the shared database, so a single instance is the right default for a self-host. The `bun` driver's broadcasts only reach clients of the **same process**, so to run more than one broadcaster instance behind a load balancer (for connection headroom or HA), enable the Redis adapter so a broadcast from any instance fans out to clients connected to any other:

```bash
BROADCAST_REDIS_ENABLED=true
REDIS_HOST=...
REDIS_PORT=6379
```

The config is already wired for it (`config/realtime.ts` → `server.redis`); `buddy realtime` just doesn't require it for the single-instance default.

## Notes

- The broadcaster detects changes by polling (every few seconds), so an update surfaces within roughly one poll interval — not sub-second. For the self-host scale this targets, that's a deliberate simplicity/robustness trade: no coupling to the worker processes, and it works regardless of how many workers run. Broadcasting directly from the check jobs is a natural future optimization once the multi-process fan-out (Redis) is the norm.
