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

## Scaling with Redis (push path + multiple instances)

The single poller is the right default for a self-host. Two things change when you turn on the Redis fan-out:

```bash
BROADCAST_REDIS_ENABLED=true
REDIS_HOST=...
REDIS_PORT=6379
BROADCAST_REDIS_PREFIX=stacks:realtime:   # must match across every process
```

1. **The check pipeline pushes instead of waiting for a poll.** When a monitor's status changes, the worker/scheduler publishes the update straight into the Redis fan-out and a Redis-enabled broadcaster relays it to browsers **sub-second**, rather than on the next poll tick. (The `bun` driver's in-process `emit()` can't reach browsers from a worker, which is exactly why this goes through Redis.)

2. **You can run more than one broadcaster.** The `bun` driver only reaches clients of the same process, so for connection headroom or HA, run one broadcaster normally (it keeps polling as the reconciliation backstop) and any extra instances with `--no-poll` — pure relays that just forward what Redis feeds them:

```bash
buddy realtime                 # relays + polls (the reconciler)
buddy realtime --no-poll       # extra instance: relay only, no DB polling
```

Every process (workers, all broadcasters) must share the **same** `BROADCAST_REDIS_PREFIX` — the fan-out key is `<prefix>channel`, and a mismatch silently drops the relay.

## Notes

- **The poll is always the safety net.** Even with Redis on, the reconciling broadcaster keeps polling, so nothing is missed if a push is dropped, and monitor types whose push isn't wired yet still update within one interval. Today the instant push covers **consensus status transitions** (uptime / ping / TCP / health going up or down, decided by `EvaluateMonitorConsensus`); the poll covers everything else (other check types, response time, last-checked). Wiring the push into the remaining check jobs is a mechanical follow-up — the poll means there's no coverage gap in the meantime.
- Without Redis, the poller detects changes every few seconds, so an update surfaces within roughly one poll interval — a deliberate simplicity/robustness trade for the single-instance default.
