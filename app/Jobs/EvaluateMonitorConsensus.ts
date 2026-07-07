import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { consensusStatus, CONSENSUS_TYPES, regionsConfig } from '../../config/regions'
import CheckResult from '../Models/CheckResult'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'
import Incident from '../Models/Incident'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'

type Status = 'up' | 'down' | 'degraded' | 'unknown'

/**
 * Runs every minute on the primary scheduler only (see app/Scheduler.ts).
 *
 * Owns the availability status transition + incident open/resolve that the
 * per-region check jobs (RunUptimeCheck / RunPingCheck / RunTcpPortCheck /
 * RunHealthCheck) used to do inline. Those jobs now only record a
 * region-tagged CheckResult; this job reads the latest fresh result per
 * region and decides the monitor's status from cross-region agreement, so
 * a single region's network blip can no longer open (or resolve) an
 * incident on its own.
 *
 * Single-region behavior is identical to the old inline logic: with one
 * configured region the required-agreement threshold clamps to 1, so the
 * newest check's status wins and transitions fire exactly as before.
 *
 * Deliberately NOT run in more than one region — it only needs to read the
 * shared DB and write the verdict once; running it per region would race.
 */
export default new Job({
  name: 'EvaluateMonitorConsensus',
  description: 'Decide monitor up/down from cross-region agreement and open/resolve incidents',
  queue: 'checks',
  tries: 1,
  timeout: 60,

  async handle() {
    const { regions, consensus } = regionsConfig
    const freshCutoff = new Date(Date.now() - consensus.freshnessSeconds * 1000).toISOString()
    const consensusTypes = new Set<string>(CONSENSUS_TYPES)
    let transitions = 0

    // Only region-based availability monitors are consensus-owned; ssl/dns/
    // domain/etc. keep their own inline status + incident logic.
    const enabled = await Monitor.where('enabled', true).get()
    const monitors = enabled.filter(m => consensusTypes.has(m.type))

    for (const monitor of monitors) {
      // Newest fresh result per region (desc order → first seen per region is
      // newest). id is the tiebreak so two checks in the same millisecond
      // still resolve to the genuinely-latest insertion.
      const recent = await CheckResult.where('monitor_id', monitor.id)
        .where('checked_at', '>=', freshCutoff)
        .orderBy('checked_at', 'desc')
        .orderBy('id', 'desc')
        .get()

      const latestByRegion = new Map<string, any>()
      for (const r of recent) {
        const region = r.region || 'default'
        if (!latestByRegion.has(region))
          latestByRegion.set(region, r)
      }

      // Count only configured regions. (`regions` already contains 'default'
      // for the single-box case — see parseRegions — so an unregioned worker's
      // votes are kept there without a special case.) The previous
      // `|| regions.includes('default')` term was a per-monitor constant: when
      // 'default' happened to be configured it disabled the filter entirely and
      // let votes from *unconfigured* regions through. If the config lists
      // regions no worker uses (mis-set env), the fallback below still keeps us
      // from blinding ourselves.
      const configured = [...latestByRegion.entries()]
        .filter(([region]) => regions.includes(region))
        .map(([, r]) => r)
      const votes = configured.length > 0 ? configured : [...latestByRegion.values()]

      // No fresh data anywhere → leave status untouched. Never resolve an
      // incident on silence (that's a worker outage, not a recovery).
      if (votes.length === 0)
        continue

      const next: Status = consensusStatus(votes.map(r => r.status), consensus.minRegionsToConfirm)

      const prev = monitor.status

      // Maintain consecutive_failures here — this job is the single writer of a
      // consensus monitor's verdict, so counting failures anywhere else (e.g.
      // per-region in the check jobs) would double-count across regions and
      // race. Without this the counter stays 0 forever and DispatchDueChecks'
      // backoff never engages, so a long-down monitor is re-probed at full
      // frequency indefinitely. 'up' resets; anything else (down/degraded)
      // increments. Persist it even when the status itself hasn't changed (a
      // monitor that stays down must keep accumulating) — but skip the write
      // when nothing moved, to avoid a write per monitor per tick when healthy.
      const nextFailures = next === 'up' ? 0 : (monitor.consecutive_failures || 0) + 1
      if (next !== prev || nextFailures !== (monitor.consecutive_failures || 0))
        await monitor.update({ status: next, consecutive_failures: nextFailures })

      if (next === prev)
        continue

      // Push this transition to the live-status broadcaster at once via the
      // Redis fan-out, so the dashboard reflects a monitor going down/up
      // sub-second instead of on the next poll. Fire-and-forget and a no-op
      // unless Redis is enabled (the `buddy realtime` poller is the
      // single-instance fallback) — never allowed to fail the verdict.
      void broadcastMonitorUpdate(monitor.id)

      if (prev !== 'down' && next === 'down') {
        const downRegions = votes.filter(r => r.status === 'down').map(r => r.region || 'default')
        const sample = votes.find(r => r.status === 'down')
        const detail = sample?.message ? `${sample.message} — ` : ''
        await Incident.create({
          monitor_id: monitor.id,
          started_at: new Date().toISOString(),
          cause: `${detail}down from ${downRegions.length}/${votes.length} region(s): ${downRegions.join(', ')}`,
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: monitor.type, regions: downRegions }]),
        })
        transitions++
        log.warn(`[job] EvaluateMonitorConsensus: ${monitor.name} DOWN (consensus: ${downRegions.join(', ')})`)
      }
      else if (prev === 'down' && next === 'up') {
        const openIncident = await Incident.where('monitor_id', monitor.id)
          .where('status', '!=', 'resolved')
          .orderByDesc('created_at')
          .first()
        if (openIncident) {
          const resolvedAt = new Date().toISOString()
          await openIncident.update({ status: 'resolved', resolved_at: resolvedAt })
          await IncidentUpdate.create({
            incident_id: openIncident.id,
            message: 'Monitor recovered — checks are passing across regions again.',
            status: 'resolved',
            posted_at: resolvedAt,
          })
        }
        transitions++
        log.info(`[job] EvaluateMonitorConsensus: ${monitor.name} recovered`)
      }
    }

    if (transitions > 0)
      log.debug(`[job] EvaluateMonitorConsensus: ${transitions} status transition(s)`)
  },
})
