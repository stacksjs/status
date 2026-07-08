import { resolve4, reverse } from 'node:dns/promises'
import process from 'node:process'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'
import { buildListings, DNSBL_ZONES, zoneLabel } from '../lib/dnsbl'

function reverseIp(ip: string): string {
  return ip.split('.').reverse().join('.')
}

/**
 * Well-known CDN/proxy edge ranges. A blocklist hit on one of these is the
 * provider's shared IP, not the customer's origin server or its mail
 * reputation, so we caveat the incident. Not exhaustive (a full PSL/WHOIS
 * lookup would be), just the ranges customers actually sit behind. Returns
 * the provider name or null.
 */
function isSharedCdnIp(ip: string): string | null {
  const octets = ip.split('.').map(Number)
  const [a, b] = octets
  // Cloudflare: 104.16.0.0/13, 172.64.0.0/13, 188.114.96.0/20, 162.158.0.0/15, 173.245.48.0/20, 103.21.244.0/22
  if ((a === 104 && b >= 16 && b <= 23) || (a === 172 && b >= 64 && b <= 71) || (a === 188 && b === 114) || (a === 162 && (b === 158 || b === 159)) || (a === 173 && b === 245))
    return 'Cloudflare'
  // Fastly 151.101.0.0/16; Akamai commonly 23.x / 104.64.0.0/10
  if (a === 151 && b === 101)
    return 'Fastly'
  return null
}

async function isListed(reversedIp: string, zone: string): Promise<boolean> {
  try {
    await resolve4(`${reversedIp}.${zone}`)
    return true
  }
  catch {
    return false // NXDOMAIN (not listed) or a resolver error — treat both as "not listed"
  }
}

/**
 * Resolves the monitor's hostname to an IPv4 address (DNSBLs are IPv4-only
 * in practice) and queries each zone in DNSBL_ZONES. A listing opens one
 * incident and keeps it open with per-run reminders (each carrying the
 * delisting URL for every zone) until the IP clears, at which point the
 * incident resolves - a blocklisting usually means something on that host
 * (or something that used to share the IP) started spamming, and it stays
 * relevant until it is actually delisted, not just for the first run.
 */
export default new Job({
  name: 'RunBlocklistCheck',
  description: 'Check a monitor\'s IP against public DNS blocklists',
  queue: 'checks',
  tries: 2,
  backoff: 30,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunBlocklistCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let hostname = monitor.url
    try {
      hostname = new URL(monitor.url).hostname
    }
    catch {
      // bare hostname, no scheme
    }

    // Prefer an explicitly configured origin IP over DNS resolution. A
    // Cloudflare/Fastly-proxied domain resolves to the CDN's shared edge IP,
    // not the customer's own server — so a blocklist check against the
    // resolved address tests the CDN's reputation, not the origin whose mail
    // deliverability actually matters (and shared edges are perpetually on
    // some list because of other tenants). Setting config.origin_ip to the
    // real server IP behind the proxy points the check at the origin.
    let monitorConfig: Record<string, unknown> = {}
    try {
      monitorConfig = JSON.parse(monitor.config || '{}')
    }
    catch {
      // malformed config — fall back to DNS resolution below
    }
    const configuredOriginIp = typeof monitorConfig.origin_ip === 'string' ? monitorConfig.origin_ip.trim() : ''

    let ip: string
    let ipSource: 'origin' | 'dns'
    if (configuredOriginIp) {
      ip = configuredOriginIp
      ipSource = 'origin'
    }
    else {
      ipSource = 'dns'
      try {
        const addresses = await resolve4(hostname)
        ip = addresses[0]!
      }
      catch {
        // reverse() as a fallback in case monitor.url is already an IP
        try {
          await reverse(hostname)
          ip = hostname
        }
        catch (error) {
          log.warn(`[job] RunBlocklistCheck: could not resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`)
          // No verdict without an IP, but last_checked_at must still advance -
          // DispatchDueChecks schedules off it, so returning without it would
          // re-dispatch this check every minute. The monitor keeps its status.
          await monitor.update({ last_checked_at: new Date().toISOString() })
          // Push this check outcome to the live-status broadcaster so the
          // dashboard updates sub-second. Fire-and-forget; a no-op unless
          // Redis fan-out is enabled (the poller is the fallback).
          void broadcastMonitorUpdate(monitor.id)
          return
        }
      }
    }

    const reversedIp = reverseIp(ip)
    const checkedAt = new Date().toISOString()

    const results = await Promise.all(DNSBL_ZONES.map(async zone => ({ zone, listed: await isListed(reversedIp, zone) })))
    const listedOn = results.filter(r => r.listed).map(r => r.zone)

    // Per-zone context (label + delisting URL + reason) built once and reused
    // for both the CheckResult metadata (dashboard rendering) and the incident.
    const listings = buildListings(listedOn, ip)
    const labels = listedOn.map(zoneLabel).join(', ')

    await CheckResult.create({
      monitor_id: monitor.id,
      status: listedOn.length > 0 ? 'degraded' : 'up',
      response_time_ms: null,
      status_code: null,
      message: listedOn.length > 0 ? `Listed on: ${labels}` : 'Not listed on any checked blocklist',
      metadata: JSON.stringify({ ip, listedOn, ipSource, listings }),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    // Level-triggered incident lifecycle: one incident stays open while the IP
    // is listed, a per-run IncidentUpdate reminds while it persists (timeline
    // only - an IncidentUpdate emits no event, so it does not re-page), and it
    // resolves when the IP clears. Previously this fired once per newly-added
    // zone and never resolved, so a persistent listing went quiet after the
    // first run and a recovered one lingered open forever (stacksjs/status#1).
    const openIncident = (await Incident.where('monitor_id', monitor.id).where('status', '!=', 'resolved').get())
      .find((incident) => {
        try {
          return JSON.parse(incident.impacted_checks || '[]')[0]?.type === 'dns_blocklist'
        }
        catch {
          return false
        }
      })

    if (listedOn.length > 0) {
      const sharedEdge = ipSource === 'dns' ? isSharedCdnIp(ip) : null
      if (!openIncident) {
        // `cause` is capped at 500 chars, so the per-list URLs ride in
        // impacted_checks and the prose stays short.
        const cause = sharedEdge
          ? `${ip} (a shared ${sharedEdge} edge IP, likely not your own server) is listed on ${labels}. This usually reflects other tenants behind the same CDN. Set this monitor's origin IP in its config to check your own server; see the incident details for delisting links.`
          : `${ip}${ipSource === 'origin' ? ' (configured origin)' : ''} is listed on ${labels}. Mail from this IP may be filtered as spam. See the incident details for per-list delisting links, and send outbound mail through a reputable relay.`

        await Incident.create({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: cause.slice(0, 500),
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: 'dns_blocklist', ip, ipSource, sharedEdge: sharedEdge || null, listings }]),
        })
        log.warn(`[job] RunBlocklistCheck: ${monitor.name} (${ip}, ${ipSource}) listed on ${labels}${sharedEdge ? ` (shared ${sharedEdge} IP)` : ''}`)
      }
      else {
        const delistLines = listings.map(l => `${l.label}: ${l.delistUrl ?? 'n/a'}`).join(' | ')
        await IncidentUpdate.create({
          incident_id: openIncident.id,
          message: `Still listed on ${labels}. Delisting: ${delistLines}`.slice(0, 2000),
          status: 'monitoring',
          posted_at: checkedAt,
        })
      }
    }
    else if (openIncident) {
      // Cleared: resolving the incident fires the recovery notification.
      await openIncident.update({ status: 'resolved', resolved_at: checkedAt })
      await IncidentUpdate.create({
        incident_id: openIncident.id,
        message: 'No longer listed on any checked blocklist.',
        status: 'resolved',
        posted_at: checkedAt,
      })
      log.info(`[job] RunBlocklistCheck: ${monitor.name} (${ip}) delisted - incident resolved`)
    }

    // Mirror the status recorded in the CheckResult above onto the monitor -
    // DispatchDueChecks schedules off last_checked_at, so skipping this
    // update would re-dispatch the check every minute.
    const status: 'up' | 'degraded' = listedOn.length > 0 ? 'degraded' : 'up'
    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    void broadcastMonitorUpdate(monitor.id)
  },
})
