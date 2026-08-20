import process from 'node:process'
import { connect } from 'node:tls'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { configBool, parseMonitorConfig } from '../lib/monitorConfig'
import { openIncident } from '../lib/maintenance'
import { channelFiresFor } from '../lib/notificationSeverity'
import { daysUntilExpiry as daysUntil, isSslIncident, tlsPortFor, WARNING_THRESHOLDS_DAYS, warnAtThreshold } from '../lib/sslExpiry'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'
import MonitorNotificationChannel from '../Models/MonitorNotificationChannel'
import SslCertificate from '../Models/SslCertificate'
import SendNotification from './SendNotification'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * First value of a certificate Distinguished Name field.
 *
 * A DN may repeat an attribute (two O= entries, say), so Node types these as
 * `string | string[]`. Everything downstream stores a single string.
 */
function firstDnValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value))
    return value[0]
  return value
}

function fetchPeerCertificate(hostname: string, port = 443): Promise<import('node:tls').PeerCertificate> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port, servername: hostname, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate()
      socket.end()
      if (!cert || Object.keys(cert).length === 0)
        reject(new Error('No certificate returned by peer'))
      else
        resolve(cert)
    })
    socket.on('error', reject)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('TLS connection timed out'))
    })
  })
}

/**
 * Checks the TLS certificate served by a monitor's URL: records issuer,
 * validity window, and fingerprint. An expired certificate (or a failed
 * TLS handshake) opens an incident, which notifies channels with critical
 * severity. A certificate merely *approaching* expiry notifies the
 * monitor's channels directly at each WARNING_THRESHOLDS_DAYS crossing
 * (warning severity, once per threshold, deduped against the previous
 * check) — deliberately NOT an incident, so a "renew within 14 days"
 * heads-up never shows up as an outage on a public status page.
 *
 * Incidents this job opens are deduped against an already-open one and
 * auto-resolve when the certificate is healthy again, the same lifecycle
 * RunBlocklistCheck and RunAiCheck implement. Without it a lapsed
 * certificate re-opened an incident on EVERY check — re-paging every
 * channel and every status-page subscriber each cycle, forever, and never
 * resolving on renewal because ssl is not a CONSENSUS_TYPE.
 */
export default new Job({
  name: 'RunSslCheck',
  description: 'Check the TLS certificate for a monitor',
  queue: 'checks',
  tries: 2,
  backoff: 30,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunSslCheck: monitor ${payload.monitorId} not found`)
      return
    }

    const startedAt = performance.now()
    const url = new URL(monitor.url)
    const hostname = url.hostname
    const port = tlsPortFor(url)
    const checkedAt = new Date().toISOString()

    /**
     * This monitor's currently-open SSL incident, if any. Scoped by
     * impacted_checks type so an unrelated open incident (say an uptime
     * outage on the same monitor) neither suppresses an SSL incident nor
     * gets resolved when the certificate recovers.
     */
    const findOpenSslIncident = async () =>
      (await Incident.where('monitor_id', monitor.id).where('status', '!=', 'resolved').get())
        .find(incident => isSslIncident(incident.impacted_checks))

    let cert: import('node:tls').PeerCertificate
    try {
      cert = await fetchPeerCertificate(hostname, port)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await CheckResult.create({
        monitor_id: monitor.id,
        status: 'down',
        responseTimeMs: Math.round(performance.now() - startedAt),
        statusCode: 0,
        message: `SSL check failed: ${message}`,
        metadata: JSON.stringify({ hostname }),
        region: process.env.WORKER_REGION || 'default',
        checkedAt: checkedAt,
      })
      // last_checked_at must advance on every terminal path - DispatchDueChecks
      // schedules off it, so skipping it would re-dispatch this check every minute.
      await monitor.update({ status: 'down', last_checked_at: checkedAt, consecutive_failures: monitor.consecutive_failures + 1 })
      // Push this check outcome to the live-status broadcaster so the
      // dashboard updates sub-second. Fire-and-forget; a no-op unless
      // Redis fan-out is enabled (the poller is the fallback).
      void broadcastMonitorUpdate(monitor.id)
      // Dedup: a handshake that keeps failing must not re-page every cycle.
      if (!(await findOpenSslIncident())) {
        await openIncident({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `SSL check failed: ${message}`,
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: 'ssl', message }]),
        })
      }
      log.warn(`[job] RunSslCheck: ${monitor.name} — ${message}`)
      return
    }

    const expiresAt = new Date(cert.valid_to)
    const daysUntilExpiry = daysUntil(expiresAt.getTime(), Date.now())
    const fingerprint = cert.fingerprint256 ?? cert.fingerprint ?? ''

    const previous = await SslCertificate.where('monitor_id', monitor.id).orderByDesc('created_at').first()

    await SslCertificate.create({
      monitor_id: monitor.id,
      // Node types these DN fields as `string | string[]` because a
      // Distinguished Name may legitimately repeat an attribute. Take the
      // first value rather than letting an array reach a string column, where
      // it would stringify as "a,b" and quietly corrupt the stored issuer.
      issuer: firstDnValue(cert.issuer?.O) ?? firstDnValue(cert.issuer?.CN) ?? 'Unknown',
      subject: firstDnValue(cert.subject?.CN) ?? hostname,
      validFrom: new Date(cert.valid_from).toISOString(),
      expiresAt: expiresAt.toISOString(),
      fingerprint,
      lastCheckedAt: checkedAt,
    })

    const fingerprintChanged = previous && previous.fingerprint && previous.fingerprint !== fingerprint
    const expiringSoon = WARNING_THRESHOLDS_DAYS.some(days => daysUntilExpiry <= days)

    if (daysUntilExpiry < 0) {
      // Dedup: an expired certificate stays expired until someone renews it.
      if (!(await findOpenSslIncident())) {
        await openIncident({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `SSL certificate for ${hostname} expired ${Math.abs(daysUntilExpiry)} day(s) ago`,
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: 'ssl', daysUntilExpiry }]),
        })
      }
      log.warn(`[job] RunSslCheck: ${monitor.name} certificate EXPIRED`)
    }
    else if (expiringSoon) {
      // Warn once per threshold (see app/lib/sslExpiry.ts): the previous
      // check's position on the ladder is recomputed from that check's own
      // stored timestamps, and a renewal resets it.
      const previousDaysUntilExpiry = previous
        ? daysUntil(new Date(previous.expires_at).getTime(), new Date(previous.last_checked_at || previous.created_at).getTime())
        : null
      const threshold = warnAtThreshold({ daysUntilExpiry, previousDaysUntilExpiry, fingerprintChanged: !!fingerprintChanged })

      if (threshold !== null) {
        // SSL warnings are soft "issue" events, so only channels that fire on
        // issues (or both) hear them - a down-only pager stays quiet.
        const attachments = (await MonitorNotificationChannel.where('monitor_id', monitor.id).get())
          .filter(attachment => channelFiresFor(attachment.fires_on, 'issue'))
        for (const attachment of attachments) {
          await SendNotification.dispatch({
            channelId: attachment.notification_channel_id,
            subject: `⚠️ ${monitor.name}: certificate expires in ${daysUntilExpiry} day(s)`,
            message: `The TLS certificate for ${hostname} expires on ${expiresAt.toISOString().slice(0, 10)}. Renew it before visitors start seeing browser warnings.`,
            severity: 'warning',
          })
        }
        log.warn(`[job] RunSslCheck: ${monitor.name} certificate expires in ${daysUntilExpiry} day(s) — notified ${attachments.length} channel(s)`)
      }
      else {
        log.warn(`[job] RunSslCheck: ${monitor.name} certificate expires in ${daysUntilExpiry} day(s)`)
      }
    }
    else if (fingerprintChanged) {
      // A fingerprint change is usually a routine renewal, so alerting is
      // opt-in (config `alertOnFingerprintChange`) for people who want to
      // catch an UNEXPECTED swap (mis-issue, MITM). When off we just note it.
      if (configBool(parseMonitorConfig(monitor.config), 'alertOnFingerprintChange', false)) {
        // SSL warnings are soft "issue" events, so only channels that fire on
        // issues (or both) hear them - a down-only pager stays quiet.
        const attachments = (await MonitorNotificationChannel.where('monitor_id', monitor.id).get())
          .filter(attachment => channelFiresFor(attachment.fires_on, 'issue'))
        for (const attachment of attachments) {
          await SendNotification.dispatch({
            channelId: attachment.notification_channel_id,
            subject: `🔑 ${monitor.name}: TLS certificate fingerprint changed`,
            message: `The certificate for ${hostname} was replaced (new SHA-256 fingerprint ${String(fingerprint).slice(0, 32)}...). If you didn't just renew or rotate it, investigate a possible mis-issue or interception.`,
            severity: 'warning',
          })
        }
        log.warn(`[job] RunSslCheck: ${monitor.name} certificate fingerprint changed — notified ${attachments.length} channel(s)`)
      }
      else {
        log.info(`[job] RunSslCheck: ${monitor.name} certificate fingerprint changed (renewed)`)
      }
    }

    // Recovery: the handshake succeeded and the certificate is in date, so
    // whatever this job opened an incident for (failed handshake, expired
    // cert) is fixed. ssl is deliberately not a CONSENSUS_TYPE, so nothing
    // else would ever resolve it - a renewed certificate used to leave its
    // incident open forever, keeping the monitor red on the status page.
    if (daysUntilExpiry >= 0) {
      const open = await findOpenSslIncident()
      if (open) {
        await open.update({ status: 'resolved', resolved_at: checkedAt })
        await IncidentUpdate.create({
          incident_id: open.id,
          message: `Certificate for ${hostname} is valid again, expires in ${daysUntilExpiry} day(s).`,
          status: 'resolved',
          postedAt: checkedAt,
        })
        log.info(`[job] RunSslCheck: ${monitor.name} certificate healthy - incident resolved`)
      }
    }

    // An expiring-soon certificate still terminates TLS fine, so it stays
    // 'up' (the threshold warnings above cover it) - only an already-expired
    // certificate is 'down', matching the incident it opens.
    const status: 'up' | 'down' = daysUntilExpiry < 0 ? 'down' : 'up'
    const message = daysUntilExpiry < 0
      ? `Certificate expired ${Math.abs(daysUntilExpiry)} day(s) ago`
      : `Certificate valid, expires in ${daysUntilExpiry} day(s)`

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      responseTimeMs: Math.round(performance.now() - startedAt),
      statusCode: 0,
      message,
      metadata: JSON.stringify({ hostname, daysUntilExpiry, expiresAt: expiresAt.toISOString() }),
      region: process.env.WORKER_REGION || 'default',
      checkedAt: checkedAt,
    })

    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    void broadcastMonitorUpdate(monitor.id)
  },
})
