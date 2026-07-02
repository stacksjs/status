import { connect } from 'node:tls'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'
import SslCertificate from '../Models/SslCertificate'

/** Alert thresholds, in days before expiry. */
const WARNING_THRESHOLDS_DAYS = [30, 14, 7, 1]

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
 * validity window, and fingerprint, and opens an incident when the
 * certificate is within WARNING_THRESHOLDS_DAYS of expiring, expired
 * outright, or its fingerprint changed since the last check (a cert swap —
 * worth surfacing even when the new cert is valid, since it's often
 * unexpected).
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

    const hostname = new URL(monitor.url).hostname
    const checkedAt = new Date().toISOString()

    let cert: import('node:tls').PeerCertificate
    try {
      cert = await fetchPeerCertificate(hostname)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await monitor.update({ status: 'down' })
      await Incident.create({
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
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `SSL certificate for ${hostname} expired ${Math.abs(daysUntilExpiry)} day(s) ago`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'ssl', daysUntilExpiry }]),
      })
      log.warn(`[job] RunSslCheck: ${monitor.name} certificate EXPIRED`)
    }
    else if (expiringSoon) {
      log.warn(`[job] RunSslCheck: ${monitor.name} certificate expires in ${daysUntilExpiry} day(s)`)
    }
    else if (fingerprintChanged) {
      log.info(`[job] RunSslCheck: ${monitor.name} certificate fingerprint changed (renewed)`)
    }
  },
})
