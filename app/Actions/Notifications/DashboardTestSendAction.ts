import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import SendNotification from '../../Jobs/SendNotification'
import NotificationChannel from '../../Models/NotificationChannel'

/**
 * `POST /notification-channel-forms/{id}/test-send` — the dashboard's
 * "test send" button (stacksjs/status#1 Phase 8). Dispatches the exact
 * same SendNotification job real incidents use, with an obviously-fake
 * payload, so a successful test genuinely proves the channel's config
 * (webhook URL, routing key, ...) is wired correctly — not a separate,
 * possibly-drifted code path.
 *
 * Previously took a bare channel `id` with no ownership check — any
 * signed-in user could trigger a real notification (Slack/PagerDuty/
 * webhook/etc. delivery) through any other team's channel by guessing
 * its id. The channel must now belong to the requester's own team (see
 * @stacksjs/auth's team resolution).
 */
export default new Action({
  name: 'DashboardTestSendAction',
  description: 'Send a test notification through a channel',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const channelId = Number(request.get('id'))

    if (channelId) {
      const channel = await NotificationChannel.where('id', channelId).where('team_id', authTeamId).first()
      if (!channel)
        return response.forbidden('You do not have access to this channel')

      await SendNotification.dispatch({
        channelId,
        subject: 'Test notification',
        message: 'This is a test notification from your Status dashboard — if you received this, the channel is configured correctly.',
        severity: 'info',
      })
    }

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/notifications?sent=1' } })
  },
})
