import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'

const REGRESSION_MULTIPLIER = 2
const MIN_SAMPLES = 5

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]!
}

/**
 * Runs every 15 minutes (see app/Scheduler.ts) — cheap enough to check
 * every monitor with response-time history, unlike an every-minute job.
 * For each monitor, compares the last hour's p95 response time against the
 * preceding 7-day baseline (excluding the last hour, so a currently-ongoing
 * regression doesn't pull its own baseline down) and opens an incident when
 * the last hour is at least REGRESSION_MULTIPLIER times slower. Informational
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

      if (recentP95 >= baselineP95 * REGRESSION_MULTIPLIER) {
        const recentIncident = await Incident.where('monitor_id', monitor.id)
          .whereLike('cause', 'Response time degraded%')
          .where('status', '!=', 'resolved')
          .first()
        if (recentIncident) continue // already flagged, don't re-open every 15 minutes

        await Incident.create({
          monitor_id: monitor.id,
          started_at: new Date().toISOString(),
          cause: `Response time degraded: p95 over the last hour (${recentP95}ms) is ${(recentP95 / baselineP95).toFixed(1)}x the 7-day baseline (${baselineP95}ms)`,
          status: 'monitoring',
          impacted_checks: JSON.stringify([{ type: 'performance', recentP95, baselineP95 }]),
        })
        flagged++
        log.warn(`[job] CheckPerformanceTrends: ${monitor.name} degraded (${recentP95}ms vs ${baselineP95}ms baseline)`)
      }
    }

    if (flagged > 0)
      log.debug(`[job] CheckPerformanceTrends: flagged ${flagged} monitor(s)`)
  },
})
