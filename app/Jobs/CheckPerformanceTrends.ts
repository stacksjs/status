import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import { openIncident } from '../lib/maintenance'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'

const REGRESSION_MULTIPLIER = 2
/**
 * Recovery threshold, deliberately BELOW the regression threshold rather than
 * equal to it. With one shared threshold a monitor sitting near 2x flips its
 * incident open and closed on consecutive runs; production resolved 2,133 of
 * 2,381 incidents inside two minutes, and every one of those pairs paged each
 * attached channel twice. Between 1.5x and 2x nothing changes: an open
 * incident stays open, a closed one stays closed. That deadband is the point.
 */
const RECOVERY_MULTIPLIER = 1.5
const MIN_SAMPLES = 5

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]!
}

/**
 * Runs every 10 minutes (see app/Scheduler.ts) — cheap enough to check
 * every monitor with response-time history, unlike an every-minute job.
 * For each monitor, compares the last hour's p95 response time against the
 * preceding 7-day baseline (excluding the last hour, so a currently-ongoing
 * regression doesn't pull its own baseline down) and opens an incident when
 * the last hour is at least REGRESSION_MULTIPLIER times slower, and resolves
 * it again once the last hour drops back under RECOVERY_MULTIPLIER. The two
 * thresholds differ on purpose — see RECOVERY_MULTIPLIER. Informational
 * ('monitoring'), not a declared outage — the monitor may well still be 'up'.
 */
export default new Job({
  name: 'CheckPerformanceTrends',
  description: 'Detect response-time degradation across monitors',
  queue: 'checks',
  tries: 1,
  timeout: 60,

  async handle() {
    const monitors = await Monitor.where('enabled', true).get()
    const now = Date.now()
    const oneHourAgo = new Date(now - 60 * 60 * 1000).toISOString()
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
    let flagged = 0
    let recovered = 0

    for (const monitor of monitors) {
      const recent = await CheckResult.where('monitor_id', monitor.id)
        .whereBetween('checked_at', [oneHourAgo, new Date(now).toISOString()])
        .get()
      const recentTimes = recent.map(r => r.response_time_ms).filter((t): t is number => typeof t === 'number').sort((a, b) => a - b)
      if (recentTimes.length < MIN_SAMPLES) continue

      const baseline = await CheckResult.where('monitor_id', monitor.id)
        .whereBetween('checked_at', [sevenDaysAgo, oneHourAgo])
        .get()
      const baselineTimes = baseline.map(r => r.response_time_ms).filter((t): t is number => typeof t === 'number').sort((a, b) => a - b)
      if (baselineTimes.length < MIN_SAMPLES) continue

      const recentP95 = percentile(recentTimes, 95)
      const baselineP95 = percentile(baselineTimes, 95)
      if (baselineP95 <= 0) continue

      // Every open degradation incident for this monitor, not just the first.
      // Duplicates exist — two runs can both pass the open-check before either
      // inserts — and closing only `.first()` would strand the rest open
      // forever, which is how production ended up with #96379 and #96380 open
      // as a pair three milliseconds apart.
      const openDegraded = await Incident.where('monitor_id', monitor.id)
        .whereLike('cause', 'Response time degraded%')
        .where('status', '!=', 'resolved')
        .get()

      if (recentP95 >= baselineP95 * REGRESSION_MULTIPLIER) {
        if (openDegraded.length > 0) continue // already flagged, don't re-open every 15 minutes

        await openIncident({
          monitor_id: monitor.id,
          started_at: new Date().toISOString(),
          cause: `Response time degraded: p95 over the last hour (${recentP95}ms) is ${(recentP95 / baselineP95).toFixed(1)}x the 7-day baseline (${baselineP95}ms)`,
          status: 'monitoring',
          impacted_checks: JSON.stringify([{ type: 'performance', recentP95, baselineP95 }]),
        })
        flagged++
        log.warn(`[job] CheckPerformanceTrends: ${monitor.name} degraded (${recentP95}ms vs ${baselineP95}ms baseline)`)
      }
      // Recovery. This job opens these incidents, so this job has to close
      // them: nothing else will. It used to get away with having no resolve
      // branch only because EvaluateMonitorConsensus resolved whatever
      // incident happened to be open, including ones it never raised — the
      // flip-flop that produced 97% of production's incidents. Restricting
      // that job to its own `impacted_checks[].regions` marker was correct and
      // left these with no resolver at all, so they simply accumulated:
      // production carried four, two of them open since 2026-07-06, against
      // monitors reading 'up' the whole time.
      else if (openDegraded.length > 0 && recentP95 < baselineP95 * RECOVERY_MULTIPLIER) {
        const resolvedAt = new Date().toISOString()

        for (const incident of openDegraded) {
          await (incident as any).update({ status: 'resolved', resolved_at: resolvedAt })
          await IncidentUpdate.create({
            incident_id: incident.id,
            message: `Response time recovered — p95 over the last hour (${recentP95}ms) is back within ${RECOVERY_MULTIPLIER}x the 7-day baseline (${baselineP95}ms).`,
            status: 'resolved',
            postedAt: resolvedAt,
          })
        }

        recovered += openDegraded.length
        log.info(`[job] CheckPerformanceTrends: ${monitor.name} recovered (${recentP95}ms vs ${baselineP95}ms baseline)`)
      }
    }

    if (flagged > 0)
      log.debug(`[job] CheckPerformanceTrends: flagged ${flagged} monitor(s)`)
    if (recovered > 0)
      log.debug(`[job] CheckPerformanceTrends: resolved ${recovered} degradation incident(s)`)
  },
})
