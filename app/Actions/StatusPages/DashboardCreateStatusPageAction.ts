import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { planLimitsForTeam } from '../../../config/plans'
import StatusPage from '../../Models/StatusPage'

/**
 * `POST /dashboard/status-pages/create` — a plain-POST, redirect-back
 * counterpart to the JSON-returning Actions/StatusPages/
 * CreateStatusPageAction, for the dashboard's native HTML form
 * (stacksjs/status#1 Phase 8; see UpdateStatusPageAction for why these
 * dashboard actions are plain POST + redirect instead of client JS).
 * Enforces the same plan limit.
 */
export default new Action({
  name: 'DashboardCreateStatusPageAction',
  description: 'Create a status page from a dashboard form post',

  async handle(request) {
    const teamId = Number(request.get('team_id'))
    const title = String(request.get('title') ?? '')
    const slug = String(request.get('slug') ?? '')

    if (!teamId || !title || !slug)
      return response.json({ error: 'team_id, title, and slug are required' }, { status: 422 })

    const existingCount = (await StatusPage.where('team_id', teamId).get()).length
    const limits = await planLimitsForTeam(teamId)
    if (existingCount >= limits.statusPages)
      return new Response(null, { status: 302, headers: { Location: '/dashboard/status-pages?error=limit' } })

    const statusPage = await StatusPage.create({
      team_id: teamId,
      slug,
      title,
      is_public: true,
    })

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${statusPage.id}` } })
  },
})
