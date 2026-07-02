import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import Monitor from '../../Models/Monitor'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'
import SendNotification from '../../Jobs/SendNotification'

/**
 * Fires on every `incident:updated` (registered in app/Events.ts) — only
 * acts when the update transitioned the incident to 'resolved'. The event
 * payload is the post-update state with no diff against the previous
 * status, so this can't distinguish "just resolved" from "updated again
 * after already being resolved" — acceptable here since nothing in this
 * codebase updates an already-resolved incident again.
 */
export default new Action({
  name: 'SendIncidentResolvedNotification',
  description: 'Notify configured channels when an incident resolves',

  async handle(incident: { monitor_id: number, status: string }) {
    if (incident.status !== 'resolved') return

    const monitor = await Monitor.find(incident.monitor_id)
    if (!monitor) return

    const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
    if (attachments.length === 0) return

    const subject = `✅ ${monitor.name} has recovered`
    const message = `${monitor.url} is passing its ${monitor.type} check again.`

    for (const attachment of attachments) {
      await SendNotification.dispatch({
        channelId: attachment.notification_channel_id,
        subject,
        message,
        severity: 'info',
      })
    }

    log.debug(`[listener] SendIncidentResolvedNotification: notified ${attachments.length} channel(s) for ${monitor.name}`)
  },
})
