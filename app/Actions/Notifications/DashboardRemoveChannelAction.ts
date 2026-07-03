import { Action } from '@stacksjs/actions'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'

/**
 * `POST /notification-channel-forms/monitors/{monitorId}/remove` —
 * detaches a notification channel from a monitor (stacksjs/status#1
 * Phase 8). Removes the pivot row only; the channel itself is untouched.
 */
export default new Action({
  name: 'DashboardRemoveChannelAction',
  description: 'Detach a notification channel from a monitor from a dashboard form',

  async handle(request) {
    const monitorId = Number(request.get('monitorId'))
    const channelId = Number(request.get('channel_id'))

    if (monitorId && channelId) {
      const pivot = await MonitorNotificationChannel.where('monitor_id', monitorId).where('notification_channel_id', channelId).first()
      if (pivot) await pivot.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}` } })
  },
})
