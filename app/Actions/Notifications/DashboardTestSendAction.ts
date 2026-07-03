import { Action } from '@stacksjs/actions'
import SendNotification from '../../Jobs/SendNotification'

/**
 * `POST /notification-channel-forms/{id}/test-send` — the dashboard's
 * "test send" button (stacksjs/status#1 Phase 8). Dispatches the exact
 * same SendNotification job real incidents use, with an obviously-fake
 * payload, so a successful test genuinely proves the channel's config
 * (webhook URL, routing key, ...) is wired correctly — not a separate,
 * possibly-drifted code path.
 */
export default new Action({
  name: 'DashboardTestSendAction',
  description: 'Send a test notification through a channel',

  async handle(request) {
    const channelId = Number(request.get('id'))

    if (channelId) {
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
