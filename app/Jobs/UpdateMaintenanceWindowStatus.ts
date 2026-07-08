import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { expandWindowIntervals, inAnyInterval } from '../lib/maintenance'
import MaintenanceWindow from '../Models/MaintenanceWindow'

/**
 * Runs every minute (see app/Scheduler.ts) — keeps MaintenanceWindow.status
 * in sync with startsAt/endsAt (stacksjs/status#1 Phase 12). Precomputing
 * status here (rather than deriving it from timestamps at status-page
 * render time) means every status-page view is a plain status='active'
 * filter instead of a timestamp comparison across every window on every
 * request.
 *
 * 'cancelled' is a terminal, manually-set state (see the useApi-generated
 * PATCH route) — this job never touches a cancelled window, same as
 * 'completed' once reached.
 */
export default new Job({
  name: 'UpdateMaintenanceWindowStatus',
  description: 'Transition maintenance windows between scheduled/active/completed based on their timestamps',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const now = Date.now()
    let transitioned = 0

    // Only scheduled/active windows can transition; cancelled/completed one-offs
    // are terminal. Recurring windows are handled separately below.
    const windows = [
      ...await MaintenanceWindow.where('status', 'scheduled').get(),
      ...await MaintenanceWindow.where('status', 'active').get(),
    ]

    for (const window of windows) {
      // A recurring window never "completes" - it cycles. Drive its status from
      // whether now falls inside a current occurrence, and never mark it
      // completed, so the dashboard reads active/scheduled honestly.
      if (window.recurrence_cron && String(window.recurrence_cron).trim()) {
        const inside = inAnyInterval(now, expandWindowIntervals(window, now, now))
        const desired = inside ? 'active' : 'scheduled'
        if (window.status !== desired) {
          await window.update({ status: desired })
          transitioned++
        }
        continue
      }

      if (window.status === 'scheduled' && now >= new Date(window.starts_at).getTime()) {
        await window.update({ status: 'active' })
        transitioned++
      }
      else if (window.status === 'active' && now >= new Date(window.ends_at).getTime()) {
        await window.update({ status: 'completed' })
        transitioned++
      }
    }

    if (transitioned > 0)
      log.debug(`[job] UpdateMaintenanceWindowStatus: transitioned ${transitioned} window${transitioned === 1 ? '' : 's'}`)
  },
})
