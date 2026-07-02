import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Monitor from '../Models/Monitor'
import RunUptimeCheck from './RunUptimeCheck'

/**
 * Runs every minute (see app/Scheduler.ts) and fans out a RunUptimeCheck job
 * for every enabled uptime monitor whose checkIntervalSeconds has elapsed
 * since its last check. Filtering in JS rather than SQL date arithmetic
 * keeps this portable across SQLite/Postgres/MySQL without dialect-specific
 * interval syntax — the monitor count this needs to scale to before that
 * matters is far beyond what a single-process scheduler tick should be
 * doing anyway (see stacksjs/status#1 Phase 11, queue scaling).
 *
 * Only 'uptime' is wired up so far; other check types (Phase 2+) will add
 * their own branch here once their job exists.
 */
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
      if (monitor.type !== 'uptime')
        continue

      const lastCheckedAt = monitor.last_checked_at ? new Date(monitor.last_checked_at).getTime() : null
      const dueAt = lastCheckedAt ? lastCheckedAt + monitor.check_interval_seconds * 1000 : 0
      if (now < dueAt)
        continue

      await RunUptimeCheck.dispatch({ monitorId: monitor.id })
      dispatched++
    }

    if (dispatched > 0)
      log.debug(`[job] DispatchDueChecks: dispatched ${dispatched} check${dispatched === 1 ? '' : 's'}`)
  },
})
