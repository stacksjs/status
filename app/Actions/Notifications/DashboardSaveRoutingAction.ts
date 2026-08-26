import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { normalizeFiresOn } from '../../lib/notificationSeverity'
import Monitor from '../../Models/Monitor'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'
import NotificationChannel from '../../Models/NotificationChannel'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `POST /notification-channel-forms/monitors/{monitorId}/routing` — saves a
 * monitor's whole alert routing in one submit.
 *
 * Replaces the previous assign/remove pair, which each moved one channel at
 * a time: routing three channels meant three round trips through a dropdown,
 * and there was no single view of which of your channels were and weren't
 * routed. The form now renders every team channel with a checkbox, so this
 * receives the complete intended state and reconciles against it.
 *
 * The submitted shape is one pair of fields per channel — `chan_<id>`
 * (present only when checked) and `fires_<id>` — rather than a repeated
 * `channels[]` field, because the request's field accessor is a flat
 * key/value map and would keep only one value of a repeated name.
 *
 * Absence means detach, so the reconcile is driven by the team's channel
 * list rather than by what was posted: a channel the operator unchecked
 * sends nothing at all, and iterating the posted fields alone could never
 * see it.
 */
export default new Action({
  name: 'DashboardSaveRoutingAction',
  description: 'Save a monitor\'s full notification-channel routing from a dashboard form',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const monitorId = Number(request.get('monitorId'))
    if (!monitorId)
      return response.json({ error: 'monitorId is required' }, { status: 422 })

    const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
    if (!monitor)
      return response.forbidden('You do not have access to this monitor')

    const teamChannels = await NotificationChannel.where('team_id', authTeamId).get()
    const attachments = await MonitorNotificationChannel.where('monitor_id', monitorId).get()
    const attachedByChannel = new Map(attachments.map(a => [Number(a.notification_channel_id), a]))

    for (const channel of teamChannels) {
      const channelId = Number(channel.id)
      const attachment = attachedByChannel.get(channelId)
      const wanted = !!request.get(`chan_${channelId}`)

      if (!wanted) {
        if (attachment) await attachment.delete()
        continue
      }

      const firesOn = normalizeFiresOn(request.get(`fires_${channelId}`))
      if (attachment) {
        if (attachment.fires_on !== firesOn) await attachment.update({ fires_on: firesOn })
      }
      else {
        await MonitorNotificationChannel.create({ monitor_id: monitorId, notification_channel_id: channelId, firesOn })
      }
    }

    // Attachments to channels outside this team can only exist because the
    // old assign endpoint shipped without an ownership check (any signed-in
    // user could attach any team's channel to any team's monitor). The grid
    // can't render them, so leaving them would mean this team's incidents
    // keep paging another team's Slack with no way to see or stop it.
    for (const [channelId, attachment] of attachedByChannel) {
      if (!teamChannels.some(c => Number(c.id) === channelId))
        await attachment.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}?routing=1` } })
  },
})
