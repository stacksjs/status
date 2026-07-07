import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import EvaluateAssertionsAction from '../Actions/Assertions/EvaluateAssertionsAction'
import CheckResult from '../Models/CheckResult'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * Runs a single HTTP uptime check for one monitor and records the result as
 * a region-tagged CheckResult. Dispatched per-monitor by DispatchDueChecks,
 * which runs on the scheduler every minute and fans out only the monitors
 * whose checkIntervalSeconds has elapsed.
 *
 * It does NOT set the monitor's status or open/resolve incidents itself —
 * that is decided centrally by EvaluateMonitorConsensus from cross-region
 * agreement, so a single region's blip can't page anyone.
 */
export default new Job({
  name: 'RunUptimeCheck',
  description: 'Run an HTTP uptime check for a single monitor',
  queue: 'checks',
  tries: 2,
  backoff: 10,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const { monitorId } = payload

    const monitor = await Monitor.find(monitorId)
    if (!monitor) {
      log.warn(`[job] RunUptimeCheck: monitor ${monitorId} not found`)
      return
    }

    const startedAt = performance.now()
    let status: 'up' | 'down' | 'degraded' = 'down'
    let statusCode: number | undefined
    let message = ''

    // SSRF guard: only ever fetch http/https. monitor.url is user-supplied and
    // Bun's fetch honors file:/data:/blob: schemes, so an unguarded fetch turns
    // a monitor into a local-file/SSRF read whose contents land in CheckResult.
    let allowed = false
    try {
      const scheme = new URL(monitor.url).protocol
      allowed = scheme === 'http:' || scheme === 'https:'
    }
    catch { allowed = false }

    if (!allowed) {
      const checkedAt = new Date().toISOString()
      await CheckResult.create({
        monitor_id: monitor.id,
        status: 'down',
        response_time_ms: 0,
        status_code: 0,
        message: 'Invalid monitor URL: only http/https targets are supported',
        metadata: JSON.stringify({}),
        region: process.env.WORKER_REGION || 'default',
        checked_at: checkedAt,
      })
      await monitor.update({ last_checked_at: checkedAt })
      void broadcastMonitorUpdate(monitor.id)
      return
    }

    try {
      const response = await fetch(monitor.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      statusCode = response.status
      status = response.status >= 200 && response.status < 400 ? 'up' : 'down'
      message = status === 'up' ? 'OK' : `Unexpected status code ${response.status}`

      // Assertions (stacksjs/status#1 Phase 12) only run when the base
      // HTTP check already passed — a 500 is already "down" regardless of
      // what the body says. Body is read in full for keyword/JSONPath-ish
      // matching; fine for typical monitored health/API/HTML endpoints,
      // not meant for streaming huge payloads.
      if (status === 'up') {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
        const body = await response.text().catch(() => '')

        const evaluation = await EvaluateAssertionsAction.handle({
          monitorId: monitor.id,
          subject: { statusCode: response.status, headers, body, responseTimeMs: Math.round(performance.now() - startedAt) },
        })

        if (!evaluation.passed) {
          status = 'down'
          message = evaluation.failures.join('; ')
        }
      }
    }
    catch (error) {
      status = 'down'
      message = error instanceof Error ? error.message : String(error)
    }

    const responseTimeMs = Math.round(performance.now() - startedAt)
    const checkedAt = new Date().toISOString()

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: responseTimeMs,
      status_code: statusCode ?? 0,
      message,
      metadata: JSON.stringify({}),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    // Status + incident transitions are owned centrally by
    // EvaluateMonitorConsensus (cross-region agreement). This job only records
    // this region's observation as the CheckResult above and advances
    // last_checked_at so DispatchDueChecks keeps scheduling it.
    await monitor.update({ last_checked_at: checkedAt })
    // Push this check outcome to the live-status broadcaster so the
    // dashboard updates sub-second. Fire-and-forget; a no-op unless
    // Redis fan-out is enabled (the poller is the fallback).
    void broadcastMonitorUpdate(monitor.id)
  },
})
