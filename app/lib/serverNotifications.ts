import process from 'node:process'
import { log } from '@stacksjs/logging'
import MonitorNotificationChannel from '../Models/MonitorNotificationChannel'
import Monitor from '../Models/Monitor'
import Server from '../Models/Server'
import SendNotification from '../Jobs/SendNotification'
import { channelFiresFor, incidentSeverity } from './notificationSeverity'
import { isServerInMaintenance } from './serverIncidents'

/** Absolute base URL for the server link, from APP_URL (scheme optional). */
function appBaseUrl(): string {
  const raw = String(process.env.APP_URL || 'statushq.org').replace(/\/$/, '')
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`
}

export interface ServerIncidentPayload {
  id?: number
  server_id?: number | null
  monitor_id?: number | null
  cause?: string
  status: string
  started_at?: string
  impacted_checks?: string | null
}

/**
 * Fan out a box-level incident (server_hot / server_silent) to the channels of
 * every monitor sitting on that box.
 *
 * One hot box is ONE incident, so it must also be one message per channel:
 * three sites on the same machine routed to the same Slack channel produce one
 * Slack message, not three. That is the whole reason this collapses by
 * notification_channel_id rather than iterating attachments the way the
 * monitor fan-out does.
 *
 * Severity is always 'issue' for both kinds (notificationSeverity.ts): a
 * server never pages as an outage — only a site's own monitor does.
 *
 * No status-page subscribers: a warm CPU is not something the public page's
 * audience experiences, and every status-page query keys on monitor_id
 * anyway.
 */
export async function notifyServerIncident(incident: ServerIncidentPayload, event: 'opened' | 'resolved'): Promise<void> {
  const serverId = Number(incident.server_id)
  if (!serverId)
    return

  const server = await Server.find(serverId)
  if (!server)
    return

  const startedAtMs = incident.started_at ? Date.parse(incident.started_at) : Number.NaN
  if (await isServerInMaintenance(server.id, Number.isFinite(startedAtMs) ? startedAtMs : Date.now())) {
    log.debug(`[listener] notifyServerIncident: ${server.name} is inside a maintenance window - not notifying`)
    return
  }

  // The team predicate guards exactly one thing: a monitor whose server_id was
  // pointed at another team's box contributes none of its channels. It is not
  // a defence against a forged incident — that is the API's job.
  const monitors = await Monitor.where('server_id', server.id).where('team_id', server.team_id).get()
  if (monitors.length === 0)
    return

  const monitorIds = monitors.map((monitor: any) => monitor.id)
  const attachments = await MonitorNotificationChannel.whereIn('monitor_id', monitorIds).get()
  if (attachments.length === 0)
    return

  // Server incidents carry no monitor type; the marker in impacted_checks is
  // the whole classification, and it always answers 'issue'.
  const severity = incidentSeverity('', incident.impacted_checks)

  // A channel fires if ANY of its attachments wants this severity.
  const firing = new Set<number>()
  for (const attachment of attachments) {
    if (channelFiresFor((attachment as any).fires_on, severity))
      firing.add(Number((attachment as any).notification_channel_id))
  }
  if (firing.size === 0)
    return

  const kind = markerType(incident.impacted_checks)
  const subject = event === 'resolved'
    ? `✅ ${server.name} has recovered`
    : kind === 'server_silent'
      ? `⚠️ ${server.name}: agent went quiet`
      : `⚠️ ${server.name}: box is hot`
  const message = incident.cause || (kind === 'server_silent'
    ? `No metrics received from the '${server.name}' agent.`
    : `Host resource thresholds breached on ${server.name}.`)

  // Same field names as the monitor context, so no channel template changes:
  // the box's dashboard page stands in for the site URL.
  const serverContext = { id: server.id, name: server.name, url: `${appBaseUrl()}/dashboard/servers/${server.id}` }
  const incidentContext = { id: incident.id ?? 0, status: incident.status, started_at: incident.started_at ?? '' }

  for (const channelId of firing) {
    await SendNotification.dispatch({
      channelId,
      subject,
      message,
      // Never 'critical': a hot or silent box is an issue by construction.
      severity: event === 'resolved' ? 'info' : 'warning',
      event: event === 'resolved' ? 'incident.resolved' : 'incident.opened',
      monitor: serverContext,
      incident: incidentContext,
    })
  }

  log.debug(`[listener] notifyServerIncident: notified ${firing.size} channel(s) for server ${server.name} (${event}, ${severity})`)
}

function markerType(impactedChecks?: string | null): string {
  try {
    const first = JSON.parse(impactedChecks || '[]')[0]
    return typeof first?.type === 'string' ? first.type : ''
  }
  catch {
    return ''
  }
}
