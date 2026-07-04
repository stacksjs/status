import { URL } from 'node:url'
import { lookup } from '@stacksjs/whois'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import DomainRegistration from '../Models/DomainRegistration'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'
import MonitorNotificationChannel from '../Models/MonitorNotificationChannel'
import SendNotification from './SendNotification'

const WARNING_THRESHOLDS_DAYS = [30, 14, 7, 1]

/**
 * The tightest warning threshold the registration has crossed, or null
 * when it isn't near expiry (same dedup scheme as RunSslCheck: a warning
 * notification fires once per crossing, not on every check).
 */
function crossedThreshold(daysUntilExpiry: number): number | null {
  const crossed = WARNING_THRESHOLDS_DAYS.filter(days => daysUntilExpiry <= days)
  return crossed.length > 0 ? Math.min(...crossed) : null
}

/** WHOIS field names vary by TLD/registrar — check common variants in order. */
function findField(parsed: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = parsed[key]
    if (typeof value === 'string')
      return value
  }
  return undefined
}

/**
 * Some registries (notably Verisign's .com/.net) emit timestamps like
 * `2026-08-13T040000Z` — no colons in the time portion — which `Date`
 * can't parse (`Invalid Date`). Insert them before parsing.
 */
function parseWhoisDate(raw: string): Date {
  const normalized = raw.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1T$2:$3:$4Z',
  )
  return new Date(normalized)
}

export default new Job({
  name: 'RunDomainCheck',
  description: 'Check domain registration expiry via WHOIS',
  queue: 'checks',
  tries: 2,
  backoff: 60,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunDomainCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let hostname = monitor.url
    try {
      hostname = new URL(monitor.url).hostname
    }
    catch {
      // bare hostname, no scheme
    }
    // WHOIS operates on the registrable domain, not subdomains.
    const parts = hostname.split('.')
    const domain = parts.length > 2 ? parts.slice(-2).join('.') : hostname

    const checkedAt = new Date().toISOString()

    let parsed: Record<string, unknown> | null = null
    try {
      const result = await lookup(domain)
      parsed = result.parsedData
    }
    catch (error) {
      log.warn(`[job] RunDomainCheck: WHOIS lookup failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (!parsed) {
      log.warn(`[job] RunDomainCheck: no parsed WHOIS data for ${domain}`)
      return
    }

    const expiryRaw = findField(parsed, ['Registry Expiry Date', 'Expiration Date', 'Expiry Date', 'paid-till'])
    const registeredRaw = findField(parsed, ['Creation Date', 'Created', 'Registered On'])
    const registrar = findField(parsed, ['Registrar', 'Sponsoring Registrar'])

    if (!expiryRaw) {
      log.warn(`[job] RunDomainCheck: could not find an expiry date in WHOIS response for ${domain}`)
      return
    }

    const expiresAt = parseWhoisDate(expiryRaw)
    if (Number.isNaN(expiresAt.getTime())) {
      log.warn(`[job] RunDomainCheck: unparseable expiry date '${expiryRaw}' for ${domain}`)
      return
    }

    // Fetch the previous record before writing the new one — it anchors the
    // once-per-threshold warning dedup below.
    const previous = await DomainRegistration.where('monitor_id', monitor.id).orderByDesc('created_at').first()

    await DomainRegistration.create({
      monitor_id: monitor.id,
      registrar: registrar ?? 'Unknown',
      registered_at: registeredRaw ? parseWhoisDate(registeredRaw).toISOString() : null,
      expires_at: expiresAt.toISOString(),
      last_checked_at: checkedAt,
    })

    const daysUntilExpiry = Math.floor((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))

    if (daysUntilExpiry < 0) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `Domain ${domain} registration expired ${Math.abs(daysUntilExpiry)} day(s) ago`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'domain', daysUntilExpiry }]),
      })
      log.warn(`[job] RunDomainCheck: ${domain} registration EXPIRED`)
    }
    else if (WARNING_THRESHOLDS_DAYS.some(days => daysUntilExpiry <= days)) {
      // Notify channels once per threshold crossing (30/14/7/1 days), not on
      // every check. A renewal pushes expiry out, so previousThreshold simply
      // stops matching and no further warnings fire.
      const threshold = crossedThreshold(daysUntilExpiry)
      const previousDaysUntilExpiry = previous
        ? Math.floor((new Date(previous.expires_at).getTime() - new Date(previous.last_checked_at || previous.created_at).getTime()) / (1000 * 60 * 60 * 24))
        : null
      const previousThreshold = previousDaysUntilExpiry === null ? null : crossedThreshold(previousDaysUntilExpiry)

      if (threshold !== null && threshold !== previousThreshold) {
        const attachments = await MonitorNotificationChannel.where('monitor_id', monitor.id).get()
        for (const attachment of attachments) {
          await SendNotification.dispatch({
            channelId: attachment.notification_channel_id,
            subject: `⚠️ ${monitor.name}: domain expires in ${daysUntilExpiry} day(s)`,
            message: `The registration for ${domain} expires on ${expiresAt.toISOString().slice(0, 10)}. Renew it with your registrar to keep the domain.`,
            severity: 'warning',
          })
        }
        log.warn(`[job] RunDomainCheck: ${domain} registration expires in ${daysUntilExpiry} day(s) — notified ${attachments.length} channel(s)`)
      }
      else {
        log.warn(`[job] RunDomainCheck: ${domain} registration expires in ${daysUntilExpiry} day(s)`)
      }
    }
  },
})
