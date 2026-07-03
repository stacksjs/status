import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '../../../config/auth-team'
import StatusPage from '../../Models/StatusPage'
import StatusPageMonitor from '../../Models/StatusPageMonitor'

/**
 * `POST /dashboard/status-pages/{id}/monitors/remove` — detaches a
 * monitor from a status page (stacksjs/status#1 Phase 8). Removes the
 * pivot row only; the Monitor itself is untouched.
 *
 * Previously took `id`/`monitor_id` with no ownership check at all.
 * The status page must now belong to the requester's own team (see
 * config/auth-team.ts) — the pivot lookup itself is scoped through the
 * status page, so no separate monitor-ownership check is needed.
 */
export default new Action({
  name: 'DashboardRemoveMonitorAction',
  description: 'Detach a monitor from a status page from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const statusPageId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))

    if (statusPageId && monitorId) {
      const statusPage = await StatusPage.where('id', statusPageId).where('team_id', authTeamId).first()
      if (!statusPage)
        return response.forbidden('You do not have access to this status page')

      const pivot = await StatusPageMonitor.where('status_page_id', statusPageId).where('monitor_id', monitorId).first()
      if (pivot) await pivot.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${statusPageId}` } })
  },
})
