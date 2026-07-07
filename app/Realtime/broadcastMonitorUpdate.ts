import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'

/**
 * Direct-to-Redis monitor broadcast (stacksjs/status#1 Phase 8 follow-up:
 * push path). The `buddy realtime` poller is the single-instance default;
 * this is the OTHER half — a worker/scheduler process (which has no
 * in-process WebSocket server, so `@stacksjs/realtime`'s `emit()` is a
 * no-op there) publishes a monitor update straight into the Redis fan-out,
 * and a Redis-enabled broadcaster relays it to browsers sub-second.
 *
 * Deliberately a no-op unless `config.realtime.server.redis.enabled` — the
 * single-instance deployment has no Redis and relies entirely on the
 * poller, so this must add zero behavior (and zero Redis dependency) there.
 * Errors are logged-and-swallowed: a live-status push is a side channel,
 * never allowed to fail the check that triggered it.
 */

export interface RedisBroadcastConfig { host: string, port: number, password?: string, keyPrefix: string }

/**
 * Resolve the Redis fan-out settings, or null when Redis broadcasting is
 * off. Shared by the publisher here AND the `buddy realtime` server so both
 * sides use the IDENTICAL `keyPrefix` — ts-broadcasting's fan-out key is
 * `${keyPrefix}channel`, and a mismatch silently breaks the relay. Note the
 * config calls it `prefix`; ts-broadcasting calls it `keyPrefix`.
 */
export function resolveRedisBroadcastConfig(): RedisBroadcastConfig | null {
  const r = (config.realtime as { server?: { redis?: { enabled?: boolean, host?: string, port?: number, password?: string, prefix?: string } } })?.server?.redis
  if (!r || !r.enabled)
    return null
  return {
    host: r.host || 'localhost',
    port: Number(r.port || 6379),
    password: r.password || undefined,
    keyPrefix: r.prefix || 'broadcasting:',
  }
}

type RedisAdapterLike = { connect: () => Promise<void>, broadcast: (channel: string, event: string, data: unknown) => Promise<void> }

// One long-lived adapter per process (a publisher + subscriber pair). Built
// lazily on first use and reused — never per-message (each connect opens
// sockets). Cached as a promise so concurrent callers share one connect.
let adapterPromise: Promise<RedisAdapterLike | null> | null = null

async function getAdapter(settings: RedisBroadcastConfig): Promise<RedisAdapterLike | null> {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      const mod = await import('@stacksjs/realtime').catch(() => null) as { RedisAdapter?: new (cfg: RedisBroadcastConfig) => RedisAdapterLike } | null
      if (!mod?.RedisAdapter)
        return null
      const adapter = new mod.RedisAdapter(settings)
      await adapter.connect()
      return adapter
    })().catch((err) => {
      log.debug(`[realtime] redis adapter init failed: ${err instanceof Error ? err.message : String(err)}`)
      adapterPromise = null // allow a later retry
      return null
    })
  }
  return adapterPromise
}

/**
 * Publish `monitor:updated` for one monitor to its team's channel, with the
 * same event/payload/channel shape the poller emits — so the dashboard
 * client needs no change. Resolves the team's uuid (the channel is keyed by
 * the unguessable uuid, not the numeric id) and the latest response time
 * from the DB. Silently returns when Redis is off, the monitor is gone, or
 * the team has no uuid.
 */
export async function broadcastMonitorUpdate(monitorId: number): Promise<void> {
  try {
    const settings = resolveRedisBroadcastConfig()
    if (!settings)
      return

    const monitor = await db.selectFrom('monitors').where('id', '=', monitorId)
      .select(['id', 'team_id', 'status', 'last_checked_at']).executeTakeFirst() as { id: number, team_id: number, status: string, last_checked_at: string | null } | undefined
    if (!monitor)
      return

    const team = await db.selectFrom('teams').where('id', '=', monitor.team_id).select(['uuid']).executeTakeFirst() as { uuid: string | null } | undefined
    if (!team?.uuid)
      return

    const adapter = await getAdapter(settings)
    if (!adapter)
      return

    const rt = await db.selectFrom('check_results').where('monitor_id', '=', monitorId).where('response_time_ms', '>=', 0)
      .orderBy('id', 'desc').limit(1).select(['response_time_ms']).executeTakeFirst() as { response_time_ms?: number } | undefined

    await adapter.broadcast(`team.${team.uuid}.monitors`, 'monitor:updated', {
      id: monitor.id,
      status: monitor.status,
      lastCheckedAt: monitor.last_checked_at,
      responseTimeMs: rt ? Number(rt.response_time_ms) : null,
    })
  }
  catch (err) {
    log.debug(`[realtime] broadcastMonitorUpdate(${monitorId}) failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}
