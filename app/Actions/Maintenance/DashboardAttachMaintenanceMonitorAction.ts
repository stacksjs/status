import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import MaintenanceWindow from '../../Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../Models/MaintenanceWindowMonitor'
import Monitor from '../../Models/Monitor'
import { resolveOrCreateTeamId } from '../../lib/teamContext'

/**
 * `POST /api/maintenance-forms/{id}/monitors/add` — put a monitor inside a
 * window.
 *
 * This attachment is what the whole feature does: app/lib/maintenance.ts
 * looks up a monitor's covering windows to decide whether a failing check
 * opens an incident and pages, and a status page only shows a maintenance
 * banner when one of ITS monitors is attached. A window with no monitors
 * announces itself and suppresses nothing.
 *
 * Both ids must belong to the requester's own team — the same ownership
 * check DashboardAssignMonitorAction had to grow, for the same reason:
 * without it a signed-in user could suppress another team's alerting.
 */
export default new Action({
  name: 'DashboardAttachMaintenanceMonitorAction',
  description: 'Attach a monitor to a maintenance window from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveOrCreateTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const windowId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))

    if (windowId && monitorId) {
      const window = await MaintenanceWindow.where('id', windowId).where('team_id', authTeamId).first()
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      if (!window || !monitor)
        return response.forbidden('You do not have access to this maintenance window or monitor')

      // No-op when already attached rather than creating a duplicate row:
      // maintenanceIntervalsByMonitor would then expand the same window
      // twice for that monitor, which is harmless for suppression but
      // double-counts in any interval listing.
      const existing = await MaintenanceWindowMonitor
        .where('maintenance_window_id', windowId)
        .where('monitor_id', monitorId)
        .first()

      if (!existing) {
        await MaintenanceWindowMonitor.create({
          maintenance_window_id: windowId,
          monitor_id: monitorId,
        })
      }
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/maintenance/${windowId}` } })
  },
})
