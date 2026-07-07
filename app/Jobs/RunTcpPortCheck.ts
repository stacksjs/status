import { connect } from 'node:net'
import process from 'node:process'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

function checkPort(host: string, port: number, timeoutMs = 10_000): Promise<{ open: boolean, timeMs: number }> {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    const socket = connect({ host, port, timeout: timeoutMs })

    const finish = (open: boolean): void => {
      socket.destroy()
      resolve({ open, timeMs: Math.round(performance.now() - startedAt) })
    }

    socket.on('connect', () => finish(true))
    socket.on('timeout', () => finish(false))
    socket.on('error', () => finish(false))
  })
}

/**
 * Validates service-level availability on a specific port, once host
 * reachability is already established (pairs with RunPingCheck). Port comes
 * from monitor.config (JSON: { "port": 5432 }), defaulting to 443.
 */
export default new Job({
  name: 'RunTcpPortCheck',
  description: 'TCP connect check for a monitor',
  queue: 'checks',
  tries: 2,
  backoff: 10,
  timeout: 20,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunTcpPortCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let host = monitor.url
    try {
      host = new URL(monitor.url).hostname
    }
    catch {
      // bare host, no scheme
    }

    let port = 443
    try {
      const config = monitor.config ? JSON.parse(monitor.config) : {}
      if (typeof config.port === 'number')
        port = config.port
    }
    catch {
      // malformed config JSON — fall back to the default port
    }

    const checkedAt = new Date().toISOString()
    const result = await checkPort(host, port)
    const status = result.open ? 'up' : 'down'

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: result.timeMs,
      status_code: null,
      message: result.open ? `Port ${port} open` : `Port ${port} closed or unreachable`,
      metadata: JSON.stringify({ port }),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    // Status + incident transitions are owned centrally by
    // EvaluateMonitorConsensus (cross-region agreement); this job just records
    // the region observation above and advances last_checked_at.
    await monitor.update({ last_checked_at: checkedAt })
    // Push this check outcome to the live-status broadcaster so the
    // dashboard updates sub-second. Fire-and-forget; a no-op unless
    // Redis fan-out is enabled (the poller is the fallback).
    void broadcastMonitorUpdate(monitor.id)
  },
})
