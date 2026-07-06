import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
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

  async handle(incident: { monitor_id: number, cause?: string, status: string }) {
    const monitor = await Monitor.find(incident.monitor_id)
    if (!monitor) return

    const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
    if (attachments.length === 0) return

    // Not every incident is an outage. Blocklist listings, broken links,
    // slowdowns, and score drops are "issues" (degraded), so calling them
    // "is down" with a red siren over-alarms. Match the wording and the
    // channel severity to the check type.
    const ISSUE_TYPES = new Set(['dns_blocklist', 'broken_links', 'lighthouse', 'performance', 'dns'])
    const isIssue = ISSUE_TYPES.has(monitor.type)
    const subject = isIssue ? `⚠️ ${monitor.name}: issue detected` : `🔴 ${monitor.name} is down`
    const message = incident.cause || `A ${monitor.type} check failed for ${monitor.url}.`

    for (const attachment of attachments) {
      await SendNotification.dispatch({
        channelId: attachment.notification_channel_id,
        subject,
        message,
        severity: isIssue ? 'warning' : 'critical',
      })
    }

    await NotifyStatusPageSubscribers.dispatch({ monitorId: monitor.id, subject, message })

    log.debug(`[listener] SendIncidentNotification: notified ${attachments.length} channel(s) for ${monitor.name}`)
  },
})
