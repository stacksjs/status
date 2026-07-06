import { resolve4, reverse } from 'node:dns/promises'
import process from 'node:process'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'

/**
 * Public DNSBL (DNS-based Blocklist) zones. A listing means "queried IP
 * appears on this spam/abuse blocklist" — the standard lookup mechanism is
 * a DNS A-record query for the IP's octets reversed, prefixed onto the
 * zone (e.g. 1.2.3.4 listed on zen.spamhaus.org is queried as
 * 4.3.2.1.zen.spamhaus.org); a resolvable answer (conventionally in the
 * 127.0.0.x range) means listed, NXDOMAIN means clean.
 */
const DNSBL_ZONES = [
  'zen.spamhaus.org',
  'b.barracudacentral.org',
  'dnsbl.sorbs.net',
  'bl.spamcop.net',
]

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
 * in practice) and queries each zone in DNSBL_ZONES. New listings vs the
 * last check open an incident — a fresh blocklisting on an IP that was
 * previously clean usually means something on that host (or something that
 * used to share the IP) started spamming, which is worth surfacing fast.
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
          return
        }
      }
    }

    const reversedIp = reverseIp(ip)
    const checkedAt = new Date().toISOString()

    const results = await Promise.all(DNSBL_ZONES.map(async zone => ({ zone, listed: await isListed(reversedIp, zone) })))
    const listedOn = results.filter(r => r.listed).map(r => r.zone)

    const previous = await CheckResult.where('monitor_id', monitor.id).orderByDesc('created_at').first()
    let previousListedOn: string[] = []
    if (previous?.metadata) {
      try {
        previousListedOn = JSON.parse(previous.metadata).listedOn ?? []
      }
      catch {
        // malformed metadata from a differently-shaped previous check — ignore
      }
    }

    await CheckResult.create({
      monitor_id: monitor.id,
      status: listedOn.length > 0 ? 'degraded' : 'up',
      response_time_ms: null,
      status_code: null,
      message: listedOn.length > 0 ? `Listed on: ${listedOn.join(', ')}` : 'Not listed on any checked blocklist',
      metadata: JSON.stringify({ ip, listedOn, ipSource }),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    const newListings = listedOn.filter(zone => !previousListedOn.includes(zone))
    if (newListings.length > 0) {
      const sharedEdge = ipSource === 'dns' ? isSharedCdnIp(ip) : null
      const cause = sharedEdge
        ? `${ip} (a shared ${sharedEdge} edge IP, likely not your own server) is listed on ${newListings.join(', ')}. This usually reflects other sites behind the same CDN and rarely affects your own mail deliverability. To check the server behind ${sharedEdge} instead, set this monitor's origin IP in its config.`
        : `${ip}${ipSource === 'origin' ? ' (configured origin)' : ''} is listed on ${newListings.join(', ')}. Mail from this IP may be filtered as spam. Request delisting from the operator and send outbound mail through a reputable relay (SES, Postmark) rather than the server directly.`

      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'dns_blocklist', ip, newListings, sharedEdge: sharedEdge || null, ipSource }]),
      })
      log.warn(`[job] RunBlocklistCheck: ${monitor.name} (${ip}, ${ipSource}) newly listed on ${newListings.join(', ')}${sharedEdge ? ` (shared ${sharedEdge} IP)` : ''}`)
    }

    // Mirror the status recorded in the CheckResult above onto the monitor -
    // DispatchDueChecks schedules off last_checked_at, so skipping this
    // update would re-dispatch the check every minute.
    const status: 'up' | 'degraded' = listedOn.length > 0 ? 'degraded' : 'up'
    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
  },
})
