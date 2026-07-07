import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { createServer, emit, stopServer } from '@stacksjs/realtime'
import { resolveRedisBroadcastConfig } from '../Realtime/broadcastMonitorUpdate'

export interface MonitorRow { id: number, team_id: number, status: string, last_checked_at: string | null }
export interface MonitorSnapshot { status: string, lastChecked: string | null }
export interface MonitorBroadcast { channel: string, id: number, status: string, lastCheckedAt: string | null }

/**
 * Pure change detector (exported for testing). Given the previous
 * snapshot (status + last_checked_at per monitor), the current monitor
 * rows, and a team_id -> uuid map, MUTATES `lastSeen` to the current
 * snapshot and returns the broadcasts to emit. A broadcast fires when an
 * ALREADY-TRACKED monitor's status OR last_checked_at changes — the
 * latter means a fresh check ran, so the dashboard's response time and
 * "last checked" can update live, not just the status dot. A
 * first-sighting is recorded silently (natural priming, no spurious event
 * for a freshly-created monitor), and a monitor that disappeared is
 * dropped so a re-created id can't inherit a stale snapshot. Monitors
 * whose team has no uuid produce no broadcast (the channel is keyed by
 * the unguessable team uuid).
 */
export function computeMonitorBroadcasts(
  lastSeen: Map<number, MonitorSnapshot>,
  rows: MonitorRow[],
  teamUuid: Map<number, string>,
): MonitorBroadcast[] {
  const out: MonitorBroadcast[] = []
  for (const m of rows) {
    const prev = lastSeen.get(m.id)
    lastSeen.set(m.id, { status: m.status, lastChecked: m.last_checked_at })
    if (prev === undefined || (prev.status === m.status && prev.lastChecked === m.last_checked_at))
      continue
    const uuid = teamUuid.get(m.team_id)
    if (!uuid)
      continue
    out.push({ channel: `team.${uuid}.monitors`, id: m.id, status: m.status, lastCheckedAt: m.last_checked_at })
  }
  const live = new Set(rows.map(r => r.id))
  for (const id of lastSeen.keys()) if (!live.has(id)) lastSeen.delete(id)
  return out
}

/**
 * `buddy realtime` — the live-status broadcaster (stacksjs/status#1
 * Phase 8 follow-up: stacks-realtime for live-updating monitor status).
 *
 * Hosts the WebSocket broadcast server (the `bun` driver — a native Bun
 * WebSocket server, no Redis/Pusher) AND polls the monitors table on a
 * short interval, emitting `monitor:updated` to a per-team channel
 * (`team.{teamId}.monitors`) whenever a monitor's status changes. The
 * dashboard's monitor list subscribes and updates its status dots in
 * place, so a monitor going down is reflected without a page reload.
 *
 * Deliberately a single self-contained process that reads the shared
 * database, rather than broadcasting from inside the check workers: the
 * `bun` driver's `emit()` only reaches clients of the SAME process, so
 * one broadcaster serving all browsers is both simplest and correct for
 * the self-host default. Horizontal scale (multiple broadcaster
 * instances behind a load balancer) needs the Redis adapter
 * (BROADCAST_REDIS_ENABLED=true, see config/realtime.ts) so a broadcast
 * from any instance fans out to clients connected to any other — the
 * config is already wired for it; this command just doesn't require it.
 *
 * Run it alongside `buddy serve`/`buddy dev` and the queue worker. The
 * WS endpoint is `ws(s)://<host>:<BROADCAST_PORT>/ws`.
 */
export default function (cli: CLI) {
  cli
    .command('realtime', 'Start the realtime monitor-status broadcaster (WebSocket)')
    .option('--port <port>', 'WebSocket port (defaults to BROADCAST_PORT / config.realtime.server.port)')
    .option('--interval <ms>', 'Poll interval in milliseconds', { default: 3000 })
    .option('--no-poll', 'Relay only — do not poll the DB. For extra broadcaster instances behind a load balancer when Redis fan-out is on (the workers push; one poller reconciles).')
    .action(async (options: { port?: string, interval?: number, poll?: boolean }) => {
      const rt = config.realtime as { server?: { host?: string, port?: number, scheme?: string } }
      const host = rt.server?.host || '0.0.0.0'
      const port = Number(options.port || rt.server?.port || 6001)
      const interval = Math.max(500, Number(options.interval || 3000))

      // When Redis fan-out is on, wire the adapter into the server so it
      // RELAYS broadcasts published by worker/scheduler processes (the push
      // path) to this instance's connected browsers. keyPrefix must match
      // the publisher's exactly — both read it from the shared resolver.
      const redisCfg = resolveRedisBroadcastConfig()
      // `--no-poll` yields `poll: false` (cac negates `--no-*`). Only honor
      // it when Redis relaying is on — a poll-less, Redis-less broadcaster
      // would sit silent, so fall back to polling in that misconfiguration.
      const polling = options.poll !== false || !redisCfg

      await createServer({
        default: 'bun',
        connections: { bun: { host, port, scheme: (rt.server?.scheme as 'ws' | 'wss') || 'ws' } },
        ...(redisCfg ? { redis: redisCfg } : {}),
      } as never)
      const mode = redisCfg ? (polling ? 'redis relay + poll' : 'redis relay (no poll)') : 'poll'
      log.info(`[realtime] broadcaster listening on ws://${host}:${port}/ws (${mode}${polling ? `, every ${interval}ms` : ''})`)

      // Snapshot of the last-seen status + last_checked_at per monitor. A
      // monitor seen for the FIRST time (prev === undefined) is only
      // recorded, never emitted — that primes the map on the first poll so
      // a freshly-created monitor doesn't fire a spurious "changed" event.
      // A broadcast then fires on a status change OR a new check
      // (last_checked_at change), so the dashboard's status dot, response
      // time, and "last checked" all update live.
      const lastSeen = new Map<number, MonitorSnapshot>()
      // team_id -> team uuid. The channel is keyed by the team's
      // unguessable uuid, not its numeric id, so this WS server can stay
      // unauthenticated without letting a stranger subscribe to a team's
      // status feed by guessing a small integer (knowing the uuid = the
      // capability). The dashboard subscribes with the same uuid.
      const teamUuid = new Map<number, string>()

      async function poll() {
        try {
          const teams = await db.selectFrom('teams').select(['id', 'uuid']).execute() as Array<{ id: number, uuid: string | null }>
          teamUuid.clear()
          for (const t of teams) if (t.uuid) teamUuid.set(t.id, String(t.uuid))

          const rows = await db.selectFrom('monitors').select(['id', 'team_id', 'status', 'last_checked_at']).execute() as MonitorRow[]
          const broadcasts = computeMonitorBroadcasts(lastSeen, rows, teamUuid)
          if (broadcasts.length === 0)
            return

          // Latest response time for exactly the monitors that changed
          // this poll (usually a small set — only those checked since the
          // last poll), one row each. Absent/negative samples surface as
          // null so the dashboard shows "--".
          const responseTimeById = new Map<number, number | null>()
          for (const b of broadcasts) {
            const rt = await db.selectFrom('check_results')
              .where('monitor_id', '=', b.id).where('response_time_ms', '>=', 0)
              .orderBy('id', 'desc').limit(1)
              .select(['response_time_ms']).executeTakeFirst() as { response_time_ms?: number } | undefined
            responseTimeById.set(b.id, rt ? Number(rt.response_time_ms) : null)
          }

          for (const b of broadcasts) {
            emit(b.channel, 'monitor:updated', {
              id: b.id,
              status: b.status,
              lastCheckedAt: b.lastCheckedAt,
              responseTimeMs: responseTimeById.get(b.id) ?? null,
            })
            log.debug(`[realtime] monitor ${b.id} -> ${b.status} on ${b.channel}`)
          }
        }
        catch (error) {
          log.error(`[realtime] poll failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // In relay-only mode the workers push every update via Redis, so this
      // instance does no DB polling — it just relays what the adapter feeds
      // it to its connected browsers.
      let timer: ReturnType<typeof setInterval> | null = null
      if (polling) {
        await poll()
        timer = setInterval(poll, interval)
      }

      const shutdown = async () => {
        if (timer)
          clearInterval(timer)
        await stopServer().catch(() => {})
        log.info('[realtime] broadcaster stopped')
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)

      // Keep the process alive.
      await new Promise(() => {})
    })
}
