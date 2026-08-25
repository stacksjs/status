import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import MaintenanceWindow from '../../Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../Models/MaintenanceWindowMonitor'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `POST /api/maintenance-forms/{id}/delete` — remove a window entirely.
 *
 * Cancelling and deleting mean different things and both are offered:
 * cancelling keeps the record and its history (and resumes alerting, since
 * a cancelled window means the work did not happen), while deleting is for
 * a window created by mistake. Prefer cancel for anything that was ever
 * announced to subscribers.
 *
 * Pivot rows go first — maintenance_window_monitors references the window,
 * so dropping the parent first trips the FK. Same children-before-parents
 * teardown the feature tests use.
 */
export default new Action({
  name: 'DashboardDeleteMaintenanceWindowAction',
  description: 'Delete a maintenance window from a dashboard form post',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const windowId = Number(request.get('id'))
    if (!windowId)
      return response.json({ error: 'id is required' }, { status: 422 })

    const window = await MaintenanceWindow.where('id', windowId).where('team_id', authTeamId).first()
    if (!window)
      return response.forbidden('You do not have access to this maintenance window')

    for (const link of await MaintenanceWindowMonitor.where('maintenance_window_id', windowId).get())
      await (link as any).delete()

    await (window as any).delete()

    return new Response(null, { status: 302, headers: { Location: '/dashboard/maintenance?deleted=1' } })
  },
})
