import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { CONSENSUS_TYPES } from '../../config/regions'
import { parseMetricsThresholds } from '../Actions/Agents/metricsThresholds'
import CheckResult from '../Models/CheckResult'
import { openIncident } from '../lib/maintenance'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/** Monitor types whose availability verdict EvaluateMonitorConsensus owns. */
const CONSENSUS_MANAGED = new Set<string>(CONSENSUS_TYPES)

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
    // `whereNull('server_id')`: a monitor the backfill has attached to a
    // Server is watched by CheckStaleServers off servers.last_sample_at, and
    // a box watched by both jobs would open two missed-push incidents for one
    // silent agent. This job is deleted outright in ship step 6.
    const monitors = await Monitor.where('reports_metrics', true).where('enabled', true).whereNull('server_id').get()
    const now = Date.now()
    let overdue = 0

    for (const monitor of monitors) {
      // Only meaningful where this job owns the status; a consensus-typed
      // monitor's `up` is written by EvaluateMonitorConsensus and says nothing
      // about whether its agent is still pushing.
      if (monitor.status === 'down' && !CONSENSUS_MANAGED.has(monitor.type))
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

      // Availability of a consensus-typed monitor (uptime/ping/tcp_port/health)
      // belongs to EvaluateMonitorConsensus, which documents itself as the
      // single writer of that verdict. reportsMetrics is orthogonal to `type`,
      // so a monitor can be both — and writing `down` here started a tug-of-war
      // that flipped the status every minute forever, because the next
      // consensus tick saw the polls passing and set it straight back to `up`.
      // A silent agent on such a monitor is a metrics problem, not an outage:
      // raise the incident, leave the availability verdict to its owner.
      if (!CONSENSUS_MANAGED.has(monitor.type)) {
        await monitor.update({ status: 'down', last_checked_at: checkedAt, consecutive_failures: monitor.consecutive_failures + 1 })
        void broadcastMonitorUpdate(monitor.id)
      }

      // openIncident() suppresses a second incident with this same cause while
      // the first is unresolved, which is what keeps this idempotent across
      // ticks. Guarding on `monitor.status` instead was the old approach and it
      // could not work for a consensus-typed monitor, whose status this job
      // does not own.
      await openIncident({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `No metrics received from '${monitor.name}' agent within ${windowSeconds}s`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'server_metrics', reason: 'missed_push', windowSeconds }]),
      })
      overdue++
      log.warn(`[job] CheckStaleMetrics: ${monitor.name} stopped pushing metrics`)
    }

    if (overdue > 0)
      log.debug(`[job] CheckStaleMetrics: ${overdue} metrics monitor(s) overdue`)
  },
})
