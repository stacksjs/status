import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import StatusPage from '../../Models/StatusPage'

/**
 * `POST /dashboard/status-pages/{id}/update` — a plain-POST alternative
 * to the useApi-generated PATCH /status-pages/{id} (stacksjs/status#1
 * Phase 8). Dashboard forms are native HTML `<form method="POST">` with
 * no client JS (this app's `<script client>` + state()/:for pattern hit
 * an unresolved bug earlier — see resources/views/dashboard/monitors/
 * index.stx's header comment), and plain HTML forms can't submit PATCH.
 * Redirects back to the edit page rather than returning JSON, since
 * this is a browser form post, not an API call.
 *
 * Previously looked up the status page by `id` alone with no ownership
 * check — any signed-in user could edit any other team's status page
 * (title, custom domain, access type) by guessing its id. Now requires
 * it to belong to the requester's own team (see @stacksjs/auth's team resolution).
 */
export default new Action({
  name: 'UpdateStatusPageAction',
  description: 'Update a status page from a dashboard form post',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const id = Number(request.get('id'))
    const statusPage = await StatusPage.where('id', id).where('team_id', authTeamId).first()
    if (!statusPage) return response.json({ error: 'Status page not found' }, { status: 404 })

    const fields: Record<string, unknown> = {}
    for (const key of ['title', 'custom_domain', 'access_type', 'locale', 'force_theme']) {
      const value = request.get(key)
      if (value !== undefined && value !== null) fields[key] = value
    }
    const isPublic = request.get('is_public')
    if (isPublic !== undefined) fields.is_public = isPublic === 'true' || isPublic === '1' || isPublic === 'on'

    await statusPage.update(fields)

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${id}` } })
  },
})
