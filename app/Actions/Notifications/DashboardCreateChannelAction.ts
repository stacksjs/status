import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { buildChannelConfig } from '../../lib/channelConfig'
import NotificationChannel from '../../Models/NotificationChannel'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `POST /notification-channel-forms/create` — dashboard form to create a
 * NotificationChannel (stacksjs/status#1 Phase 8).
 *
 * `config` used to arrive as raw JSON from a textarea, which asked the
 * operator to know the key names for their channel type and offered no
 * check that they got them right — a typo'd key produced a channel that
 * looked fine in the list and failed on its first real alert. The form now
 * posts labelled per-type fields and app/lib/channelConfig assembles the
 * JSON from the same table the form renders from, so the two cannot drift.
 *
 * team_id used to be taken from a form field with no verification at
 * all — any signed-in user could create a channel under another team by
 * posting a different team_id. It's now derived from the requester's
 * own session/token (see @stacksjs/auth's team resolution).
 */
export default new Action({
  name: 'DashboardCreateChannelAction',
  description: 'Create a notification channel from a dashboard form',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const name = String(request.get('name') ?? '').trim()
    const type = String(request.get('type') ?? '')

    if (!name || !type)
      return response.json({ error: 'name and type are required' }, { status: 422 })

    const built = buildChannelConfig(type, field => request.get(field))
    if (!built.ok)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/notifications?error=${built.error}` } })

    await NotificationChannel.create({
      teamId: authTeamId,
      name,
      type,
      config: built.config,
      enabled: true,
    })

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/notifications?created=1' } })
  },
})
