import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import Monitor from '../../Models/Monitor'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'
import NotificationChannel from '../../Models/NotificationChannel'

/**
 * `POST /notification-channel-forms/monitors/{monitorId}/assign` —
 * attaches a notification channel to a monitor from the monitor detail
 * page (stacksjs/status#1 Phase 8). No-ops if already attached.
 *
 * Previously took `monitorId`/`channel_id` with no ownership check at
 * all — any signed-in user could attach any other team's channel to
 * any other team's monitor. Both ids are now required to belong to the
 * requester's own team (see @stacksjs/auth's team resolution).
 */
export default new Action({
  name: 'DashboardAssignChannelAction',
  description: 'Attach a notification channel to a monitor from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const monitorId = Number(request.get('monitorId'))
    const channelId = Number(request.get('channel_id'))

    if (monitorId && channelId) {
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      const channel = await NotificationChannel.where('id', channelId).where('team_id', authTeamId).first()
      if (!monitor || !channel)
        return response.forbidden('You do not have access to this monitor or channel')

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
