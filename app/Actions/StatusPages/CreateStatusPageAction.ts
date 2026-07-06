import { Action } from '@stacksjs/actions'
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
    const teamId = Number(request.get('team_id'))
    if (!teamId)
      return response.json({ error: 'team_id is required' }, { status: 422 })

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
