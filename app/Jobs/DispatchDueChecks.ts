import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import AiCheck from '../Models/AiCheck'
import Monitor from '../Models/Monitor'
import RunAiCheck from './RunAiCheck'
import RunBlocklistCheck from './RunBlocklistCheck'
import RunCrawl from './RunCrawl'
import RunDnsCheck from './RunDnsCheck'
import RunDomainCheck from './RunDomainCheck'
import RunHealthCheck from './RunHealthCheck'
import RunLighthouseAudit from './RunLighthouseAudit'
import RunPingCheck from './RunPingCheck'
import RunPortScan from './RunPortScan'
import RunSslCheck from './RunSslCheck'
import RunTcpPortCheck from './RunTcpPortCheck'
import RunUptimeCheck from './RunUptimeCheck'

/**
 * Runs every minute (see app/Scheduler.ts) and fans out the right check job
 * for every enabled, pollable monitor whose checkIntervalSeconds has
 * elapsed since its last check. Filtering in JS rather than SQL date
 * arithmetic keeps this portable across SQLite/Postgres/MySQL without
 * dialect-specific interval syntax — the monitor count this needs to scale
 * to before that matters is far beyond what a single-process scheduler
 * tick should be doing anyway (see stacksjs/status#1 Phase 11, queue
 * scaling). A full-site crawl or port scan is comparatively expensive, so
 * those monitor types should be given a much longer checkIntervalSeconds
 * (e.g. daily) than an uptime/ping monitor — nothing here enforces that,
 * it's a matter of what the monitor is configured with.
 *
 * 'cron' monitors are heartbeat-based (passive — see CheckOverdueHeartbeats).
 *
 * 'ai_check' is handled separately below: a single monitor can have
 * multiple AiCheck assertions attached, so it fans out one RunAiCheck job
 * per assertion rather than one job per monitor.
 */
const MAX_BACKOFF_MULTIPLIER = 16 // caps effective interval at 16x normal, not unbounded

/**
 * Exponential backoff once a monitor has been failing for a while: 1x
 * interval for the first 2 failures, then doubling every 5 more failures,
 * capped at MAX_BACKOFF_MULTIPLIER. A site that's been down for an hour
 * doesn't need re-checking every 30s for that entire hour — it needs
 * checking often enough to catch recovery promptly, not hammered at full
 * frequency the whole time (stacksjs/status#1 Phase 11).
 */
function backoffMultiplier(consecutiveFailures: number): number {
  if (consecutiveFailures <= 2) return 1
  const doublings = Math.floor((consecutiveFailures - 2) / 5) + 1
  return Math.min(MAX_BACKOFF_MULTIPLIER, 2 ** doublings)
}

const CHECK_JOBS: Partial<Record<string, { dispatch: (payload: { monitorId: number }) => Promise<unknown> }>> = {
  uptime: RunUptimeCheck,
  // 'performance' monitors run the same HTTP check as uptime — the
  // response times it records are exactly what CheckPerformanceTrends
  // (running on its own schedule) analyzes for degradation. The
  // distinction is intent (why the monitor exists), not the check itself.
  performance: RunUptimeCheck,
  ssl: RunSslCheck,
  ping: RunPingCheck,
  tcp_port: RunTcpPortCheck,
  dns: RunDnsCheck,
  domain: RunDomainCheck,
  health: RunHealthCheck,
  broken_links: RunCrawl,
  lighthouse: RunLighthouseAudit,
  port_scan: RunPortScan,
  dns_blocklist: RunBlocklistCheck,
}

export default new Job({
  name: 'DispatchDueChecks',
  description: 'Fan out due monitor checks to the queue',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const monitors = await Monitor.where('enabled', true).get()
    const now = Date.now()
    let dispatched = 0

    for (const monitor of monitors) {
      const lastCheckedAt = monitor.last_checked_at ? new Date(monitor.last_checked_at).getTime() : null
      const effectiveIntervalSeconds = monitor.check_interval_seconds * backoffMultiplier(monitor.consecutive_failures)
      const dueAt = lastCheckedAt ? lastCheckedAt + effectiveIntervalSeconds * 1000 : 0
      if (now < dueAt)
        continue

      if (monitor.type === 'ai_check') {
        const assertions = await AiCheck.where('monitor_id', monitor.id).get()
        if (assertions.length === 0)
          continue
        for (const assertion of assertions)
          await RunAiCheck.dispatch({ monitorId: monitor.id, aiCheckId: assertion.id })
        // AiCheck has no unified up/down status of its own; touch
        // last_checked_at directly so this monitor doesn't get redispatched
        // every minute — RunAiCheck opens its own incidents per assertion.
        await monitor.update({ last_checked_at: new Date().toISOString() })
        dispatched++
        continue
      }

      const job = CHECK_JOBS[monitor.type]
      if (!job)
        continue

      await job.dispatch({ monitorId: monitor.id })
      dispatched++
    }

    if (dispatched > 0)
      log.debug(`[job] DispatchDueChecks: dispatched ${dispatched} check${dispatched === 1 ? '' : 's'}`)
  },
})
