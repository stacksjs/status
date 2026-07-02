import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'

/**
 * Application health monitoring contract: the target app exposes a JSON
 * health endpoint (default the monitor's own URL — set monitor.config.path
 * to point at e.g. "/health" instead) returning:
 *
 *   { "status": "ok" | "degraded" | "down", "checks"?: { [name]: boolean } }
 *
 * `checks` is optional structured detail (disk space, queue depth, a
 * downstream API reachability flag, ...) surfaced in the CheckResult
 * message for diagnosis; only `status` drives the up/down/degraded state
 * and incident lifecycle.
 */
export default new Job({
  name: 'RunHealthCheck',
  description: 'Poll an application health endpoint for a monitor',
  queue: 'checks',
  tries: 2,
  backoff: 10,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunHealthCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let config: { path?: string } = {}
    try {
      config = monitor.config ? JSON.parse(monitor.config) : {}
    }
    catch {
      // malformed config JSON — use the monitor URL as-is
    }

    const url = config.path ? new URL(config.path, monitor.url).toString() : monitor.url
    const checkedAt = new Date().toISOString()
    const startedAt = performance.now()

    let status: 'up' | 'down' | 'degraded' = 'down'
    let message = ''
    let metadata: Record<string, unknown> = {}

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      const body = await response.json().catch(() => null) as { status?: string, checks?: Record<string, boolean> } | null

      if (!response.ok || !body?.status) {
        status = 'down'
        message = `Health endpoint returned ${response.status}${body?.status ? '' : ' with no status field'}`
      }
      else if (body.status === 'ok') {
        status = 'up'
        message = 'Healthy'
      }
      else if (body.status === 'degraded') {
        status = 'degraded'
        message = 'Degraded'
      }
      else {
        status = 'down'
        message = `Reported status: ${body.status}`
      }
      metadata = body?.checks ? { checks: body.checks } : {}
    }
    catch (error) {
      status = 'down'
      message = error instanceof Error ? error.message : String(error)
    }

    const responseTimeMs = Math.round(performance.now() - startedAt)

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: responseTimeMs,
      status_code: null,
      message,
      metadata: JSON.stringify(metadata),
      region: 'default',
      checked_at: checkedAt,
    })

    const previousStatus = monitor.status
    await monitor.update({ status, last_checked_at: checkedAt })

    if (previousStatus !== 'down' && status === 'down') {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: message,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'health', message }]),
      })
      log.warn(`[job] RunHealthCheck: ${monitor.name} is DOWN — ${message}`)
    }
  },
})
