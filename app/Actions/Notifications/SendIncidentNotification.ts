import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import { isMonitorInMaintenance } from '../../lib/maintenance'
import { channelFiresFor, incidentSeverityForType } from '../../lib/notificationSeverity'
import Monitor from '../../Models/Monitor'
import MonitorNotificationChannel from '../../Models/MonitorNotificationChannel'
import NotifyStatusPageSubscribers from '../../Jobs/NotifyStatusPageSubscribers'
import SendNotification from '../../Jobs/SendNotification'

/**
 * Fires on `incident:created` (registered in app/Events.ts, via Incident's
 * `observe: true` trait) — notifies every channel attached to the
 * affected monitor. Fan-out is one SendNotification dispatch per channel
 * rather than sending inline here, so a slow/failing channel doesn't
 * block the others and gets its own retry/backoff.
 *
 * Deliberately does NOT re-notify on every subsequent incident update
 * (status changes as it's investigated) — only on the initial creation and
 * on resolution (see SendIncidentResolvedNotification) — otherwise a long-
 * running incident with several status updates would spam every channel
 * once per update.
 */
export default new Action({
  name: 'SendIncidentNotification',
  description: 'Notify configured channels when an incident opens',

  async handle(incident: { id?: number, monitor_id: number, cause?: string, status: string, started_at?: string }) {
    const monitor = await Monitor.find(incident.monitor_id)
    if (!monitor) return

    // Safety net for the maintenance-window contract (docs/operate/maintenance.md):
    // the auto-incident sites already skip opening an incident during a window,
    // but if one reaches here anyway, never page for a monitor that was in
    // maintenance at the incident's start time.
    const atMs = incident.started_at ? Date.parse(incident.started_at) : Date.now()
    if (await isMonitorInMaintenance(monitor.id, Number.isFinite(atMs) ? atMs : Date.now())) {
      log.debug(`[listener] SendIncidentNotification: ${monitor.name} is in a maintenance window - not notifying`)
      return
    }

    const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
    if (attachments.length === 0) return

    // Not every incident is an outage. Blocklist listings, broken links,
    // slowdowns, and score drops are "issues" (degraded), so calling them
    // "is down" with a red siren over-alarms. Match the wording and the
    // channel severity to the check type.
    const severity = incidentSeverityForType(monitor.type)
    const isIssue = severity === 'issue'
    const subject = isIssue ? `⚠️ ${monitor.name}: issue detected` : `🔴 ${monitor.name} is down`
    const message = incident.cause || `A ${monitor.type} check failed for ${monitor.url}.`

    const monitorContext = { id: monitor.id, name: monitor.name, url: monitor.url }
    const incidentContext = { id: incident.id ?? 0, status: incident.status, started_at: incident.started_at ?? '' }

    // Respect each attachment's per-severity routing (fires_on: down/issue/both).
    // Status-page subscribers are a separate audience and are always notified.
    const firing = attachments.filter(attachment => channelFiresFor(attachment.fires_on, severity))

    for (const attachment of firing) {
      await SendNotification.dispatch({
        channelId: attachment.notification_channel_id,
        subject,
        message,
        severity: isIssue ? 'warning' : 'critical',
        event: 'incident.opened',
        monitor: monitorContext,
        incident: incidentContext,
      })
    }

    await NotifyStatusPageSubscribers.dispatch({ monitorId: monitor.id, subject, message })

    log.debug(`[listener] SendIncidentNotification: notified ${firing.length}/${attachments.length} channel(s) for ${monitor.name} (${severity})`)
  },
})
