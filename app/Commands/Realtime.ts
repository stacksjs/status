import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { createServer, emit, stopServer } from '@stacksjs/realtime'

export interface MonitorRow { id: number, team_id: number, status: string }
export interface MonitorBroadcast { channel: string, id: number, status: string }

/**
 * Pure transition detector (exported for testing). Given the previous
 * status snapshot, the current monitor rows, and a team_id -> uuid map,
 * MUTATES `lastStatus` to the current snapshot and returns the broadcasts
 * to emit. Only a real status transition of an ALREADY-TRACKED monitor
 * (one seen on a previous poll) whose team has a uuid produces a
 * broadcast — a first-sighting is recorded silently (natural priming, no
 * spurious event for a freshly-created monitor), and a monitor that
 * disappeared is dropped so a re-created id can't inherit a stale status.
 */
export function computeMonitorBroadcasts(
  lastStatus: Map<number, string>,
  rows: MonitorRow[],
  teamUuid: Map<number, string>,
): MonitorBroadcast[] {
  const out: MonitorBroadcast[] = []
  for (const m of rows) {
    const prev = lastStatus.get(m.id)
    lastStatus.set(m.id, m.status)
    if (prev === undefined || prev === m.status)
      continue
    const uuid = teamUuid.get(m.team_id)
    if (!uuid)
      continue
    out.push({ channel: `team.${uuid}.monitors`, id: m.id, status: m.status })
  }
  const live = new Set(rows.map(r => r.id))
  for (const id of lastStatus.keys()) if (!live.has(id)) lastStatus.delete(id)
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
    .action(async (options: { port?: string, interval?: number }) => {
      const rt = config.realtime as { server?: { host?: string, port?: number, scheme?: string } }
      const host = rt.server?.host || '0.0.0.0'
      const port = Number(options.port || rt.server?.port || 6001)
      const interval = Math.max(500, Number(options.interval || 3000))

      await createServer({
        default: 'bun',
        connections: { bun: { host, port, scheme: (rt.server?.scheme as 'ws' | 'wss') || 'ws' } },
      } as never)
      log.info(`[realtime] broadcaster listening on ws://${host}:${port}/ws (polling every ${interval}ms)`)

      // Snapshot of the last-seen status per monitor. A monitor seen for
      // the FIRST time (prev === undefined) is only recorded, never
      // emitted — that naturally primes the map on the first poll and
      // means a freshly-created monitor doesn't fire a spurious "changed"
      // event (the dashboard adds it on next load; live updates track
      // transitions of already-visible monitors). Only a real status
      // transition of an already-tracked monitor broadcasts.
      const lastStatus = new Map<number, string>()
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

          const rows = await db.selectFrom('monitors').select(['id', 'team_id', 'status']).execute() as MonitorRow[]
          for (const b of computeMonitorBroadcasts(lastStatus, rows, teamUuid)) {
            emit(b.channel, 'monitor:updated', { id: b.id, status: b.status })
            log.debug(`[realtime] monitor ${b.id} -> ${b.status} on ${b.channel}`)
          }
        }
        catch (error) {
          log.error(`[realtime] poll failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      await poll()
      const timer = setInterval(poll, interval)

      const shutdown = async () => {
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
