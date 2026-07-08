import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import Assertion from '../../Models/Assertion'
import Monitor from '../../Models/Monitor'

/**
 * `POST /assertion-forms/monitors/{monitorId}/remove` — deletes one of a
 * monitor's response assertions from the monitor detail page. The monitor must
 * belong to the requester's own team, and the assertion is scoped to that
 * monitor so another team's assertion id can't be deleted by guessing it.
 */
export default new Action({
  name: 'DashboardRemoveAssertionAction',
  description: 'Delete a monitor response assertion from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const monitorId = Number(request.get('monitorId'))
    const assertionId = Number(request.get('assertion_id'))

    if (monitorId && assertionId) {
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      if (!monitor)
        return response.forbidden('You do not have access to this monitor')

      const assertion = await Assertion.where('id', assertionId).where('monitor_id', monitorId).first()
      if (assertion)
        await assertion.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}` } })
  },
})
