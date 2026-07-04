import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { planLimitsForTeam } from '../../../config/plans'
import StatusPage from '../../Models/StatusPage'

/**
 * `POST /dashboard/status-pages/create` — a plain-POST, redirect-back
 * counterpart to the JSON-returning Actions/StatusPages/
 * CreateStatusPageAction, for the dashboard's native HTML form
 * (stacksjs/status#1 Phase 8; see UpdateStatusPageAction for why these
 * dashboard actions are plain POST + redirect instead of client JS).
 * Enforces the same plan limit.
 *
 * team_id used to be taken from a form field with no verification —
 * any signed-in user could create (and consume plan quota for) a
 * status page under another team by posting a different team_id. It's
 * now derived from the requester's own session/token (see
 * @stacksjs/auth's team resolution).
 */
export default new Action({
  name: 'DashboardCreateStatusPageAction',
  description: 'Create a status page from a dashboard form post',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.json({ error: 'Authentication required' }, { status: 401 })

    const title = String(request.get('title') ?? '')
    const slug = String(request.get('slug') ?? '')

    if (!title || !slug)
      return response.json({ error: 'title and slug are required' }, { status: 422 })

    const existingCount = (await StatusPage.where('team_id', authTeamId).get()).length
    const limits = await planLimitsForTeam(authTeamId)
    if (existingCount >= limits.statusPages)
      return new Response(null, { status: 302, headers: { Location: '/dashboard/status-pages?error=limit' } })

    const statusPage = await StatusPage.create({
      team_id: authTeamId,
      slug,
      title,
      is_public: true,
    })

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${statusPage.id}` } })
  },
})
