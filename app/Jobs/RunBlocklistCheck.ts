import { resolve4, reverse } from 'node:dns/promises'
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

    let ip: string
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
        return
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
      metadata: JSON.stringify({ ip, listedOn }),
      region: 'default',
      checked_at: checkedAt,
    })

    const newListings = listedOn.filter(zone => !previousListedOn.includes(zone))
    if (newListings.length > 0) {
      await Incident.create({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `${ip} newly listed on DNS blocklist(s): ${newListings.join(', ')}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'dns_blocklist', newListings }]),
      })
      log.warn(`[job] RunBlocklistCheck: ${monitor.name} (${ip}) newly listed on ${newListings.join(', ')}`)
    }
  },
})
