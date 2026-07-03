import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '../../../config/auth-team'
import Monitor from '../../Models/Monitor'
import StatusPage from '../../Models/StatusPage'
import StatusPageMonitor from '../../Models/StatusPageMonitor'

/**
 * `POST /dashboard/status-pages/{id}/monitors/add` — attaches a monitor
 * to a status page from a dashboard form (stacksjs/status#1 Phase 8).
 * No-ops if already attached rather than creating a duplicate row.
 *
 * Previously took `id`/`monitor_id` with no ownership check at all —
 * any signed-in user could attach any other team's monitor to any
 * other team's status page (leaking that monitor's name/status onto a
 * public page). Both ids are now required to belong to the requester's
 * own team (see config/auth-team.ts).
 */
export default new Action({
  name: 'DashboardAssignMonitorAction',
  description: 'Attach a monitor to a status page from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const statusPageId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))
    const displayName = request.get('display_name')

    if (statusPageId && monitorId) {
      const statusPage = await StatusPage.where('id', statusPageId).where('team_id', authTeamId).first()
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      if (!statusPage || !monitor)
        return response.forbidden('You do not have access to this status page or monitor')

      const existing = await StatusPageMonitor.where('status_page_id', statusPageId).where('monitor_id', monitorId).first()
      if (!existing) {
        await StatusPageMonitor.create({
          status_page_id: statusPageId,
          monitor_id: monitorId,
          display_name: displayName || undefined,
          display_order: 0,
        })
      }
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${statusPageId}` } })
  },
})
