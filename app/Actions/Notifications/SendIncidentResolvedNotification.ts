import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import { isMonitorInMaintenance } from '../../lib/maintenance'
import Monitor from '../../Models/Monitor'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'
import NotifyStatusPageSubscribers from '../../Jobs/NotifyStatusPageSubscribers'
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

  async handle(incident: { id?: number, monitor_id: number, status: string, started_at?: string }) {
    if (incident.status !== 'resolved') return

    const monitor = await Monitor.find(incident.monitor_id)
    if (!monitor) return

    // No paging during an active maintenance window (docs/operate/maintenance.md),
    // including recovery notices - a monitor flapping back up mid-window must
    // not page. Once the window closes, a genuine recovery notifies as usual.
    if (await isMonitorInMaintenance(monitor.id)) {
      log.debug(`[listener] SendIncidentResolvedNotification: ${monitor.name} is in a maintenance window - not notifying`)
      return
    }

    const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
    if (attachments.length === 0) return

    const subject = `✅ ${monitor.name} has recovered`
    const message = `${monitor.url} is passing its ${monitor.type} check again.`

    const monitorContext = { id: monitor.id, name: monitor.name, url: monitor.url }
    const incidentContext = { id: incident.id ?? 0, status: incident.status, started_at: incident.started_at ?? '' }

    for (const attachment of attachments) {
      await SendNotification.dispatch({
        channelId: attachment.notification_channel_id,
        subject,
        message,
        severity: 'info',
        event: 'incident.resolved',
        monitor: monitorContext,
        incident: incidentContext,
      })
    }

    await NotifyStatusPageSubscribers.dispatch({ monitorId: monitor.id, subject, message })

    log.debug(`[listener] SendIncidentResolvedNotification: notified ${attachments.length} channel(s) for ${monitor.name}`)
  },
})
