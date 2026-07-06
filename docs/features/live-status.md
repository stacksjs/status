# Live monitor status (realtime)

The dashboard's monitor list updates a monitor's status dot the moment it
changes, without a page reload — a monitor going down turns red in place. This
is deployment/run guidance for the process that powers it (see
[stacksjs/status#1](https://github.com/stacksjs/status/issues/1), Phase 8).

## How it works

- `buddy realtime` starts a **broadcaster**: a WebSocket server (the `bun`
  driver — native Bun WebSockets, no Redis or Pusher required) plus a short
  poll loop over the `monitors` table.
- When a monitor's status transitions (your check workers update the row), the
  broadcaster emits a `monitor:updated` event on a per-team channel.
- The dashboard's monitor list subscribes over the WebSocket and swaps the
  status dot for the affected monitor in place. If the broadcaster is down or
  realtime is disabled, the page silently keeps its on-load snapshot — the
  feature is purely progressive enhancement.

The channel is keyed by the team's **uuid**, not its numeric id
(`team.<uuid>.monitors`). That keeps the WebSocket server unauthenticated (no
per-connection auth handshake) without letting a stranger watch a team's
status feed by guessing a small integer — knowing the uuid is the capability.
The dashboard hands the browser only its own team's uuid.

## Running it

Run the broadcaster alongside the web/API servers and the queue worker:

```bash
buddy serve          # web + API
buddy queue:work     # runs the checks that flip monitor status
buddy realtime       # the live-status broadcaster (this process)
```

Options:

- `--port <port>` — WebSocket port (defaults to `BROADCAST_PORT`, then
  `config.realtime.server.port`, then `6001`).
- `--interval <ms>` — poll interval (default `3000`).

The browser connects to `ws(s)://<app-host>:<BROADCAST_PORT>/ws`. Over TLS,
put the broadcaster behind your reverse proxy as `wss` on the app host (the
client uses `wss` automatically when the page is served over `https`).

Relevant env (see `config/realtime.ts`):

```bash
BROADCAST_PORT=6001      # WebSocket port
BROADCAST_HOST=0.0.0.0
BROADCAST_SCHEME=ws      # ws locally; wss behind a TLS proxy
```

## Scaling

One broadcaster serves every connected browser and reads the shared database,
so a single instance is the right default for a self-host. The `bun` driver's
broadcasts only reach clients of the **same process**, so to run more than one
broadcaster instance behind a load balancer (for connection headroom or HA),
enable the Redis adapter so a broadcast from any instance fans out to clients
connected to any other:

```bash
BROADCAST_REDIS_ENABLED=true
REDIS_HOST=...
REDIS_PORT=6379
```

The config is already wired for it (`config/realtime.ts` → `server.redis`);
`buddy realtime` just doesn't require it for the single-instance default.

## Limits & follow-ups

- Live updates cover a monitor's **status** (up / degraded / down / pending).
  Response time and "last checked" still refresh on the next page load.
- The broadcaster detects changes by polling (every few seconds), so a status
  change surfaces within roughly one poll interval — not sub-second. For the
  self-host scale this targets, that's a deliberate simplicity/robustness
  trade (no coupling to the worker processes, works regardless of how many
  workers run). A push path (broadcast directly from the check jobs) is a
  natural future optimization once the multi-process broadcast fan-out
  (Redis) is the norm.
