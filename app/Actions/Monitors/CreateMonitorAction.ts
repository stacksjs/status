import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { limitReachedMessage, planForTeam } from '../../../config/plans'
import Monitor from '../../Models/Monitor'

export default new Action({
  name: 'CreateMonitorAction',
  description: 'Create a monitor, enforcing the team\'s plan limit',

  async handle(request) {
    // Derive the owning team from the caller's credentials, never from the
    // request body: trusting a client-supplied team_id let an unauthenticated
    // or cross-team caller create monitors under (and burn the quota of) any
    // team (IDOR). A body team_id, if sent, must match the authenticated team.
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const requestedTeamId = request.get('team_id') != null ? Number(request.get('team_id')) : authTeamId
    if (requestedTeamId !== authTeamId)
      return response.forbidden('You do not have access to this team')

    const teamId = authTeamId

    const existingCount = (await Monitor.where('team_id', teamId).get()).length
    const { plan, limits } = await planForTeam(teamId)

    if (existingCount >= limits.monitors) {
      return response.json(
        { error: limitReachedMessage('monitors', limits.monitors, plan) },
        { status: 402 },
      )
    }

    const checkIntervalSeconds = Number(request.get('check_interval_seconds') ?? 60)
    if (checkIntervalSeconds < limits.checkIntervalFloorSeconds) {
      return response.json(
        { error: `Check interval must be at least ${limits.checkIntervalFloorSeconds}s on the ${plan} plan. Upgrade to check more frequently.` },
        { status: 402 },
      )
    }

    const monitor = await Monitor.create({
      team_id: teamId,
      name: request.get('name'),
      url: request.get('url'),
      type: request.get('type'),
      enabled: request.get('enabled') ?? true,
      check_interval_seconds: checkIntervalSeconds,
      config: request.get('config'),
      status: 'unknown',
    })

    return response.json(monitor, { status: 201 })
  },
})
