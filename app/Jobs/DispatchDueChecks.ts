import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Monitor from '../Models/Monitor'
import RunCrawl from './RunCrawl'
import RunDnsCheck from './RunDnsCheck'
import RunDomainCheck from './RunDomainCheck'
import RunHealthCheck from './RunHealthCheck'
import RunLighthouseAudit from './RunLighthouseAudit'
import RunPingCheck from './RunPingCheck'
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
 * scaling). A full-site crawl is comparatively expensive, so a
 * 'broken_links' monitor should be given a much longer
 * checkIntervalSeconds (e.g. daily) than an uptime/ping monitor — nothing
 * here enforces that, it's a matter of what the monitor is configured with.
 *
 * 'cron' monitors are heartbeat-based (passive — see CheckOverdueHeartbeats)
 * and 'performance'/'lighthouse'/'port_scan'/'dns_blocklist'/'ai_check'
 * aren't implemented yet (Phase 4+), so those are skipped here.
 */
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
      const job = CHECK_JOBS[monitor.type]
      if (!job)
        continue

      const lastCheckedAt = monitor.last_checked_at ? new Date(monitor.last_checked_at).getTime() : null
      const dueAt = lastCheckedAt ? lastCheckedAt + monitor.check_interval_seconds * 1000 : 0
      if (now < dueAt)
        continue

      await job.dispatch({ monitorId: monitor.id })
      dispatched++
    }

    if (dispatched > 0)
      log.debug(`[job] DispatchDueChecks: dispatched ${dispatched} check${dispatched === 1 ? '' : 's'}`)
  },
})
