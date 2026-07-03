import { Action } from '@stacksjs/actions'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'

/**
 * `POST /notification-channel-forms/monitors/{monitorId}/assign` —
 * attaches a notification channel to a monitor from the monitor detail
 * page (stacksjs/status#1 Phase 8). No-ops if already attached.
 */
export default new Action({
  name: 'DashboardAssignChannelAction',
  description: 'Attach a notification channel to a monitor from a dashboard form',

  async handle(request) {
    const monitorId = Number(request.get('monitorId'))
    const channelId = Number(request.get('channel_id'))

    if (monitorId && channelId) {
      const existing = await MonitorNotificationChannel.where('monitor_id', monitorId).where('notification_channel_id', channelId).first()
      if (!existing) {
        await MonitorNotificationChannel.create({
          monitor_id: monitorId,
          notification_channel_id: channelId,
        })
      }
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}` } })
  },
})
