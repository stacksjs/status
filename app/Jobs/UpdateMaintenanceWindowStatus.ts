import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
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

    const scheduled = await MaintenanceWindow.where('status', 'scheduled').get()
    for (const window of scheduled) {
      if (now >= new Date(window.starts_at).getTime()) {
        await window.update({ status: 'active' })
        transitioned++
      }
    }

    const active = await MaintenanceWindow.where('status', 'active').get()
    for (const window of active) {
      if (now >= new Date(window.ends_at).getTime()) {
        await window.update({ status: 'completed' })
        transitioned++
      }
    }

    if (transitioned > 0)
      log.debug(`[job] UpdateMaintenanceWindowStatus: transitioned ${transitioned} window${transitioned === 1 ? '' : 's'}`)
  },
})
