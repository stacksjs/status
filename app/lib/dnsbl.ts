/**
 * Public DNSBL (DNS-based Blocklist) zones and their per-zone display /
 * delisting metadata, kept here (rather than inline in RunBlocklistCheck) so
 * the "every queried zone has metadata" invariant and the delisting-URL
 * builders can be unit-tested without a live DNS check.
 *
 * A listing means "queried IP appears on this spam/abuse blocklist" - the
 * standard lookup is a DNS A-record query for the IP's octets reversed,
 * prefixed onto the zone (e.g. 1.2.3.4 listed on zen.spamhaus.org is queried
 * as 4.3.2.1.zen.spamhaus.org); a resolvable answer (conventionally in the
 * 127.0.0.x range) means listed, NXDOMAIN means clean.
 */

export const DNSBL_ZONES = [
  'zen.spamhaus.org',
  'b.barracudacentral.org',
  'dnsbl.sorbs.net',
  'bl.spamcop.net',
] as const

export interface DnsblMeta {
  /** Short, human-readable list name for incident copy. */
  label: string
  /** A lookup/removal URL for the listed IP. */
  delistUrl: (ip: string) => string
  /** Why the IP tends to land on this list and how to get off it. */
  reason: string
}

export const DNSBL_META: Record<string, DnsblMeta> = {
  'zen.spamhaus.org': {
    label: 'Spamhaus ZEN',
    delistUrl: ip => `https://check.spamhaus.org/results?query=${ip}`,
    reason: 'Spamhaus lists IPs seen sending spam or running exploited/open services. Fix the source first, then request removal from the results page.',
  },
  'b.barracudacentral.org': {
    label: 'Barracuda',
    delistUrl: () => 'https://www.barracudacentral.org/rbl/removal-request',
    reason: 'Barracuda lists IPs with a poor sending reputation. Submit the removal-request form once the underlying cause is resolved.',
  },
  'dnsbl.sorbs.net': {
    label: 'SORBS',
    delistUrl: () => 'http://www.sorbs.net/lookup.shtml',
    reason: 'SORBS lists suspected spam sources and open relays. Look the IP up and follow the per-list delisting steps.',
  },
  'bl.spamcop.net': {
    label: 'SpamCop',
    delistUrl: ip => `https://www.spamcop.net/bl.shtml?${ip}`,
    reason: 'SpamCop lists IPs reported by its spam traps; listings expire on their own once reports stop. The lookup page shows the current status.',
  },
}

/** The display label for a zone, falling back to the raw zone name. */
export function zoneLabel(zone: string): string {
  return DNSBL_META[zone]?.label ?? zone
}

/**
 * The per-zone incident context for a set of listed zones: label, delisting
 * URL for this IP, and reason. Used for both the CheckResult metadata (so the
 * dashboard can render the links) and the incident's impacted_checks.
 */
export function buildListings(listedOn: readonly string[], ip: string): Array<{ zone: string, label: string, delistUrl: string | null, reason: string | null }> {
  return listedOn.map(zone => ({
    zone,
    label: zoneLabel(zone),
    delistUrl: DNSBL_META[zone]?.delistUrl(ip) ?? null,
    reason: DNSBL_META[zone]?.reason ?? null,
  }))
}
