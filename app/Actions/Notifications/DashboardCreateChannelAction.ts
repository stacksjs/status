import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import NotificationChannel from '../../Models/NotificationChannel'

/**
 * `POST /notification-channel-forms/create` — dashboard form to create a
 * NotificationChannel (stacksjs/status#1 Phase 8). `config` is entered
 * as raw JSON in a textarea rather than a per-type field set (10 channel
 * types each have a different config shape — see NotificationChannel.ts's
 * doc comment) — simpler to build correctly than 10 bespoke forms, at
 * the cost of asking the operator to type `{"webhookUrl": "..."}`
 * instead of a labeled input. A real per-type form is a reasonable
 * follow-up, not silently equivalent to what's here.
 */
export default new Action({
  name: 'DashboardCreateChannelAction',
  description: 'Create a notification channel from a dashboard form',

  async handle(request) {
    const teamId = Number(request.get('team_id'))
    const name = String(request.get('name') ?? '')
    const type = String(request.get('type') ?? '')
    const configRaw = String(request.get('config') ?? '{}')

    if (!teamId || !name || !type)
      return response.json({ error: 'team_id, name, and type are required' }, { status: 422 })

    let config = '{}'
    try {
      JSON.parse(configRaw)
      config = configRaw
    }
    catch {
      return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/notifications?error=invalid_json' } })
    }

    await NotificationChannel.create({
      team_id: teamId,
      name,
      type,
      config,
      enabled: true,
    })

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/notifications' } })
  },
})
