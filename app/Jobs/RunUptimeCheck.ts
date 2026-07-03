import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'

/**
 * Runs a single HTTP uptime check for one monitor, records the result, and
 * opens/resolves an Incident on a status transition (down -> up or
 * up -> down). Dispatched per-monitor by DispatchDueChecks, which runs on
 * the scheduler every minute and fans out only the monitors whose
 * checkIntervalSeconds has elapsed.
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

    try {
      const response = await fetch(monitor.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      })
      statusCode = response.status
      status = response.status >= 200 && response.status < 400 ? 'up' : 'down'
      message = status === 'up' ? 'OK' : `Unexpected status code ${response.status}`
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

    const previousStatus = monitor.status
    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })

    if (previousStatus !== 'down' && status === 'down') {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: message,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'uptime', message }]),
      })
      log.warn(`[job] RunUptimeCheck: ${monitor.name} (${monitor.url}) went DOWN — ${message}`)
    }
    else if (previousStatus === 'down' && status === 'up') {
      const openIncident = await Incident.where('monitor_id', monitor.id)
        .where('status', '!=', 'resolved')
        .orderByDesc('created_at')
        .first()

      if (openIncident) {
        const resolvedAt = checkedAt
        await openIncident.update({ status: 'resolved', resolved_at: resolvedAt })
        await IncidentUpdate.create({
          incident_id: openIncident.id,
          message: 'Monitor recovered — check is passing again.',
          status: 'resolved',
          posted_at: resolvedAt,
        })
      }
      log.info(`[job] RunUptimeCheck: ${monitor.name} (${monitor.url}) recovered`)
    }
  },
})
