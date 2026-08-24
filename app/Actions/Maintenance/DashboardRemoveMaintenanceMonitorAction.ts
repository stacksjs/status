import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import MaintenanceWindow from '../../Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../Models/MaintenanceWindowMonitor'

/**
 * `POST /api/maintenance-forms/{id}/monitors/remove` — take a monitor back
 * out of a window, restoring normal incident-opening and paging for it.
 *
 * Ownership is checked on the window rather than the pivot row: the window
 * is the team-scoped record (the pivot carries no team_id), so proving the
 * window belongs to the requester is what makes deleting its links safe.
 */
export default new Action({
  name: 'DashboardRemoveMaintenanceMonitorAction',
  description: 'Detach a monitor from a maintenance window from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const windowId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))

    if (windowId && monitorId) {
      const window = await MaintenanceWindow.where('id', windowId).where('team_id', authTeamId).first()
      if (!window)
        return response.forbidden('You do not have access to this maintenance window')

      const links = await MaintenanceWindowMonitor
        .where('maintenance_window_id', windowId)
        .where('monitor_id', monitorId)
        .get()

      for (const link of links)
        await (link as any).delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/maintenance/${windowId}` } })
  },
})
