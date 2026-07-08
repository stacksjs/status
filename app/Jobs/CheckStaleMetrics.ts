import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { parseMetricsThresholds } from '../Actions/Agents/metricsThresholds'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import { openIncident } from '../lib/maintenance'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * Runs every minute (see app/Scheduler.ts). The missed-push half of server
 * metrics (stacksjs/status#1): a reportsMetrics monitor is passive like a
 * heartbeat — if the agent stops pushing (host down, agent crashed, network
 * cut), there's nothing to poll, only a deadline to watch. When no metrics
 * sample has arrived within the monitor's `metricsWindowSeconds` window, the
 * host is marked down and an incident opened.
 *
 * The baseline is the last AGENT CheckResult (region 'agent'), NOT the
 * monitor's last_checked_at — reportsMetrics is orthogonal to `type`, so a
 * monitor that is also (say) an uptime check keeps last_checked_at fresh
 * from its own polling even after metrics pushes stop. A monitor already
 * `down` is skipped (a real push recovers it via ReceiveMetricsAction).
 */
export default new Job({
  name: 'CheckStaleMetrics',
  description: 'Open incidents for server-metrics monitors whose agent stopped pushing within the expected window',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const monitors = await Monitor.where('reports_metrics', true).where('enabled', true).get()
    const now = Date.now()
    let overdue = 0

    for (const monitor of monitors) {
      if (monitor.status === 'down')
        continue

      const lastPush = await CheckResult.where('monitor_id', monitor.id)
        .where('region', '=', 'agent')
        .orderByDesc('id')
        .first()

      const baseline = lastPush?.checked_at
        ? new Date(lastPush.checked_at).getTime()
        : new Date(monitor.created_at).getTime()

      const { windowSeconds } = parseMetricsThresholds(monitor.config)
      if (now < baseline + windowSeconds * 1000)
        continue

      const checkedAt = new Date().toISOString()
      await monitor.update({ status: 'down', last_checked_at: checkedAt, consecutive_failures: monitor.consecutive_failures + 1 })
      void broadcastMonitorUpdate(monitor.id)

      // Guard against a duplicate open incident (idempotent across ticks).
      const open = await Incident.where('monitor_id', monitor.id).where('status', '!=', 'resolved').first()
      if (!open) {
        await openIncident({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `No metrics received from '${monitor.name}' agent within ${windowSeconds}s`,
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: 'server_metrics', reason: 'missed_push', windowSeconds }]),
        })
      }
      overdue++
      log.warn(`[job] CheckStaleMetrics: ${monitor.name} stopped pushing metrics`)
    }

    if (overdue > 0)
      log.debug(`[job] CheckStaleMetrics: ${overdue} metrics monitor(s) overdue`)
  },
})
