import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { limitReachedMessage, planForTeam } from '../../../config/plans'
import StatusPage from '../../Models/StatusPage'

/**
 * Overrides the useApi-generated `POST /status-pages` (user-defined
 * routes in routes/ take priority over auto-generated ones — same
 * pattern as Actions/Monitors/CreateMonitorAction) to enforce the team's
 * status-page plan limit before creating (stacksjs/status#1 Phase 9).
 */
export default new Action({
  name: 'CreateStatusPageAction',
  description: 'Create a status page, enforcing the team\'s plan limit',

  async handle(request) {
    // Bind the status page to the authenticated team, not a client-supplied
    // team_id (that trust let a cross-team caller create pages under any team
    // and consume its quota — IDOR). A body team_id must match the caller's.
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const requestedTeamId = request.get('team_id') != null ? Number(request.get('team_id')) : authTeamId
    if (requestedTeamId !== authTeamId)
      return response.forbidden('You do not have access to this team')

    const teamId = authTeamId

    const existingCount = (await StatusPage.where('team_id', teamId).get()).length
    const { plan, limits } = await planForTeam(teamId)

    if (existingCount >= limits.statusPages) {
      return response.json(
        { error: limitReachedMessage('status pages', limits.statusPages, plan) },
        { status: 402 },
      )
    }

    const statusPage = await StatusPage.create({
      team_id: teamId,
      slug: request.get('slug'),
      title: request.get('title'),
      custom_domain: request.get('custom_domain'),
      branding: request.get('branding'),
      is_public: request.get('is_public') ?? true,
    })

    return response.json(statusPage, { status: 201 })
  },
})
