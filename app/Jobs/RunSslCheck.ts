import process from 'node:process'
import { connect } from 'node:tls'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { configBool, parseMonitorConfig } from '../lib/monitorConfig'
import CheckResult from '../Models/CheckResult'
import { openIncident } from '../lib/maintenance'
import Monitor from '../Models/Monitor'
import MonitorNotificationChannel from '../Models/MonitorNotificationChannel'
import SslCertificate from '../Models/SslCertificate'
import SendNotification from './SendNotification'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/** Alert thresholds, in days before expiry. */
const WARNING_THRESHOLDS_DAYS = [30, 14, 7, 1]

/**
 * The tightest warning threshold a certificate has crossed, or null when
 * it isn't near expiry. 12 days out -> 14; 40 days out -> null.
 */
function crossedThreshold(daysUntilExpiry: number): number | null {
  const crossed = WARNING_THRESHOLDS_DAYS.filter(days => daysUntilExpiry <= days)
  return crossed.length > 0 ? Math.min(...crossed) : null
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
    const hostname = new URL(monitor.url).hostname
    const checkedAt = new Date().toISOString()

    let cert: import('node:tls').PeerCertificate
    try {
      cert = await fetchPeerCertificate(hostname)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await CheckResult.create({
        monitor_id: monitor.id,
        status: 'down',
        response_time_ms: Math.round(performance.now() - startedAt),
        status_code: 0,
        message: `SSL check failed: ${message}`,
        metadata: JSON.stringify({ hostname }),
        region: process.env.WORKER_REGION || 'default',
        checked_at: checkedAt,
      })
      // last_checked_at must advance on every terminal path - DispatchDueChecks
      // schedules off it, so skipping it would re-dispatch this check every minute.
      await monitor.update({ status: 'down', last_checked_at: checkedAt, consecutive_failures: monitor.consecutive_failures + 1 })
      // Push this check outcome to the live-status broadcaster so the
      // dashboard updates sub-second. Fire-and-forget; a no-op unless
      // Redis fan-out is enabled (the poller is the fallback).
      void broadcastMonitorUpdate(monitor.id)
      await openIncident({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `SSL check failed: ${message}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'ssl', message }]),
      })
      log.warn(`[job] RunSslCheck: ${monitor.name} — ${message}`)
      return
    }

    const expiresAt = new Date(cert.valid_to)
    const daysUntilExpiry = Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    const fingerprint = cert.fingerprint256 ?? cert.fingerprint ?? ''

    const previous = await SslCertificate.where('monitor_id', monitor.id).orderByDesc('created_at').first()

    await SslCertificate.create({
      monitor_id: monitor.id,
      issuer: cert.issuer?.O ?? cert.issuer?.CN ?? 'Unknown',
      subject: cert.subject?.CN ?? hostname,
      valid_from: new Date(cert.valid_from).toISOString(),
      expires_at: expiresAt.toISOString(),
      fingerprint,
      last_checked_at: checkedAt,
    })

    const fingerprintChanged = previous && previous.fingerprint && previous.fingerprint !== fingerprint
    const expiringSoon = WARNING_THRESHOLDS_DAYS.some(days => daysUntilExpiry <= days)

    if (daysUntilExpiry < 0) {
      await openIncident({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `SSL certificate for ${hostname} expired ${Math.abs(daysUntilExpiry)} day(s) ago`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'ssl', daysUntilExpiry }]),
      })
      log.warn(`[job] RunSslCheck: ${monitor.name} certificate EXPIRED`)
    }
    else if (expiringSoon) {
      // Warn once per threshold: compare the threshold crossed now against
      // the one already crossed at the previous check (computed from that
      // check's own timestamps). A renewed cert (fingerprint change) resets
      // the comparison, which is correct — a *new* cert that is already
      // near expiry deserves its own warning.
      const threshold = crossedThreshold(daysUntilExpiry)
      const previousDaysUntilExpiry = previous
        ? Math.floor((new Date(previous.expires_at).getTime() - new Date(previous.last_checked_at || previous.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : null
      const previousThreshold = previousDaysUntilExpiry === null || fingerprintChanged
        ? null
        : crossedThreshold(previousDaysUntilExpiry)

      if (threshold !== null && threshold !== previousThreshold) {
        const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
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
        const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
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
      response_time_ms: Math.round(performance.now() - startedAt),
      status_code: 0,
      message,
      metadata: JSON.stringify({ hostname, daysUntilExpiry, expiresAt: expiresAt.toISOString() }),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    void broadcastMonitorUpdate(monitor.id)
  },
})
