import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '../../../config/auth-team'
import Monitor from '../../Models/Monitor'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'

/**
 * `POST /notification-channel-forms/monitors/{monitorId}/remove` —
 * detaches a notification channel from a monitor (stacksjs/status#1
 * Phase 8). Removes the pivot row only; the channel itself is untouched.
 *
 * Previously took `monitorId`/`channel_id` with no ownership check at
 * all. The monitor must now belong to the requester's own team (see
 * config/auth-team.ts) — the pivot lookup itself is scoped through the
 * monitor, so no separate channel-ownership check is needed.
 */
export default new Action({
  name: 'DashboardRemoveChannelAction',
  description: 'Detach a notification channel from a monitor from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const monitorId = Number(request.get('monitorId'))
    const channelId = Number(request.get('channel_id'))

    if (monitorId && channelId) {
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      if (!monitor)
        return response.forbidden('You do not have access to this monitor')

      const pivot = await MonitorNotificationChannel.where('monitor_id', monitorId).where('notification_channel_id', channelId).first()
      if (pivot) await pivot.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}` } })
  },
})
