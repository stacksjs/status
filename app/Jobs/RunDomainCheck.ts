import process from 'node:process'
import { URL } from 'node:url'
import { lookup } from '@stacksjs/whois'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import DomainRegistration from '../Models/DomainRegistration'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'
import MonitorNotificationChannel from '../Models/MonitorNotificationChannel'
import SendNotification from './SendNotification'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

const WARNING_THRESHOLDS_DAYS = [30, 14, 7, 1]

/**
 * Common multi-label public suffixes. WHOIS operates on the *registrable*
 * domain (the label just below the public suffix), so a naive "last two
 * labels" split mishandles these: shop.example.co.uk must resolve to
 * example.co.uk, not co.uk. This is a pragmatic shortlist of the suffixes
 * real customers actually use, not the full Public Suffix List — enough to
 * make the advertised "extracts the registrable domain" claim hold for the
 * common cases without pulling in a megabyte of PSL data.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'co.jp', 'or.jp', 'ne.jp',
  'com.au', 'net.au', 'org.au', 'com.br', 'com.cn', 'com.mx', 'co.nz',
  'co.za', 'com.sg', 'co.in', 'co.kr', 'com.tr', 'com.hk', 'com.tw',
])

/**
 * Reduce a hostname to the registrable domain: the public suffix plus the
 * one label in front of it. Handles the common two-label suffixes above;
 * everything else falls back to the last two labels.
 */
export function registrableDomain(hostname: string): string {
  const parts = hostname.split('.')
  if (parts.length <= 2)
    return hostname
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && parts.length >= 3)
    return parts.slice(-3).join('.')
  return lastTwo
}

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

    const startedAt = performance.now()

    let hostname = monitor.url
    try {
      hostname = new URL(monitor.url).hostname
    }
    catch {
      // bare hostname, no scheme
    }
    // WHOIS operates on the registrable domain, not subdomains.
    const domain = registrableDomain(hostname)

    const checkedAt = new Date().toISOString()

    let parsed: Record<string, unknown> | null = null
    try {
      const result = await lookup(domain)
      parsed = result.parsedData
    }
    catch (error) {
      log.warn(`[job] RunDomainCheck: WHOIS lookup failed for ${domain}: ${error instanceof Error ? error.message : String(error)}`)
      // An inconclusive lookup is not a verdict, but last_checked_at must
      // still advance - DispatchDueChecks schedules off it, so returning
      // without it would re-dispatch this check every minute (a WHOIS-less
      // TLD would hammer the registry forever). No CheckResult row is
      // written: check_results.status is constrained to up/down/degraded
      // (see the create-check_results migration) and any of those would
      // misrepresent "could not determine", so the monitor keeps its
      // current status and the warning lives in the log.
      await monitor.update({ status: monitor.status || 'unknown', last_checked_at: checkedAt })
      // Push this check outcome to the live-status broadcaster so the
      // dashboard updates sub-second. Fire-and-forget; a no-op unless
      // Redis fan-out is enabled (the poller is the fallback).
      void broadcastMonitorUpdate(monitor.id)
      return
    }

    if (!parsed) {
      log.warn(`[job] RunDomainCheck: no parsed WHOIS data for ${domain}`)
      // Same as the lookup-failure path above: bump last_checked_at, keep status.
      await monitor.update({ status: monitor.status || 'unknown', last_checked_at: checkedAt })
      void broadcastMonitorUpdate(monitor.id)
      return
    }

    const expiryRaw = findField(parsed, ['Registry Expiry Date', 'Expiration Date', 'Expiry Date', 'paid-till'])
    const registeredRaw = findField(parsed, ['Creation Date', 'Created', 'Registered On'])
    const registrar = findField(parsed, ['Registrar', 'Sponsoring Registrar'])

    if (!expiryRaw) {
      log.warn(`[job] RunDomainCheck: could not find an expiry date in WHOIS response for ${domain}`)
      // Same as the lookup-failure path above: bump last_checked_at, keep status.
      await monitor.update({ status: monitor.status || 'unknown', last_checked_at: checkedAt })
      void broadcastMonitorUpdate(monitor.id)
      return
    }

    const expiresAt = parseWhoisDate(expiryRaw)
    if (Number.isNaN(expiresAt.getTime())) {
      log.warn(`[job] RunDomainCheck: unparseable expiry date '${expiryRaw}' for ${domain}`)
      // Same as the lookup-failure path above: bump last_checked_at, keep status.
      await monitor.update({ status: monitor.status || 'unknown', last_checked_at: checkedAt })
      void broadcastMonitorUpdate(monitor.id)
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

    // A registration approaching expiry still resolves fine, so it stays
    // 'up' (the threshold warnings above cover it) - only an already-expired
    // registration is 'down', matching the incident it opens.
    const status: 'up' | 'down' = daysUntilExpiry < 0 ? 'down' : 'up'
    const message = daysUntilExpiry < 0
      ? `Domain registration expired ${Math.abs(daysUntilExpiry)} day(s) ago`
      : `Domain registered, expires in ${daysUntilExpiry} day(s)`

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: Math.round(performance.now() - startedAt),
      status_code: 0,
      message,
      metadata: JSON.stringify({ domain, registrar: registrar ?? 'Unknown', daysUntilExpiry, expiresAt: expiresAt.toISOString() }),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    void broadcastMonitorUpdate(monitor.id)
  },
})
