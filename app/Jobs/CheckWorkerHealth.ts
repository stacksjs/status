import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Monitor from '../Models/Monitor'

const POLLABLE_TYPES = ['uptime', 'performance', 'ssl', 'ping', 'tcp_port', 'dns', 'domain', 'health', 'broken_links', 'lighthouse', 'port_scan', 'dns_blocklist']

/**
 * "Who monitors the monitor?" (stacksjs/status#1 Phase 11) — a self-check
 * for the monitoring pipeline itself, distinct from DispatchDueChecks: if
 * the queue/worker is stuck (a dead queue connection, an unhandled
 * exception looping DispatchDueChecks, ...), no Incident ever opens
 * because nothing runs to notice — the normal alerting path is exactly
 * what's stuck.
 *
 * This asks a narrower question on its own schedule: "has *any* check
 * result landed recently, given that pollable monitors exist that should
 * be producing them?" It always logs at error level when stale so
 * external log-based alerting catches it, but the more load-bearing
 * signal is WORKER_HEARTBEAT_URL: when configured (a healthchecks.io-style
 * dead-man's-switch URL), this job pings it only on the *healthy* path.
 * An external service — outside this process, unaffected by this
 * process's own queue dying — alerts on a *missed* ping. That's the only
 * non-circular way to monitor a monitoring pipeline; it's the same
 * approach Oh Dear uses to watch its own uptime.
 */
export default new Job({
  name: 'CheckWorkerHealth',
  description: 'Self-check that the monitoring pipeline is actually producing check results',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const pollable = await Monitor.where('enabled', true).whereIn('type', POLLABLE_TYPES).get()
    if (pollable.length === 0) return // nothing should be checking in, nothing to detect

    const shortestIntervalSeconds = Math.min(...pollable.map(m => m.check_interval_seconds))
    // 3x the shortest configured interval, floored at 10 minutes — enough
    // slack that one slow tick doesn't false-positive, tight enough that a
    // genuinely stuck pipeline is caught well before a customer notices
    // their status page hasn't moved.
    const staleAfterMs = Math.max(shortestIntervalSeconds * 3, 600) * 1000

    const latest = await CheckResult.orderByDesc('checked_at').first()
    const latestAt = latest ? new Date(latest.checked_at).getTime() : 0
    const staleMs = Date.now() - latestAt
    const healthy = staleMs < staleAfterMs

    if (!healthy) {
      log.error(`[job] CheckWorkerHealth: no check result recorded in ${Math.round(staleMs / 60_000)}m despite ${pollable.length} enabled monitor(s) — the check-dispatch pipeline may be stuck (queue worker down, DispatchDueChecks failing silently, or similar).`)
      return
    }

    const heartbeatUrl = process.env.WORKER_HEARTBEAT_URL
    if (!heartbeatUrl) return

    try {
      // Drain the body so Bun can return the socket to the pool rather than
      // holding the fd open until GC across repeated heartbeat pings.
      const response = await fetch(heartbeatUrl, { method: 'GET', signal: AbortSignal.timeout(10_000) })
      await response.text().catch(() => {})
    }
    catch (error) {
      log.warn(`[job] CheckWorkerHealth: failed to ping WORKER_HEARTBEAT_URL: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})
