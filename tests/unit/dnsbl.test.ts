import { describe, expect, test } from 'bun:test'
import { buildListings, DNSBL_META, DNSBL_ZONES, zoneLabel } from '../../app/lib/dnsbl'

describe('DNSBL metadata', () => {
  test('every queried zone has metadata', () => {
    for (const zone of DNSBL_ZONES) {
      const meta = DNSBL_META[zone]
      expect(meta, `missing DNSBL_META for ${zone}`).toBeDefined()
      expect(meta!.label.length).toBeGreaterThan(0)
      expect(meta!.reason.length).toBeGreaterThan(0)
      expect(meta!.delistUrl('1.2.3.4')).toMatch(/^https?:\/\//)
    }
  })

  test('IP-parameterised delisting URLs embed the IP', () => {
    const ip = '203.0.113.10'
    expect(DNSBL_META['zen.spamhaus.org']!.delistUrl(ip)).toContain(ip)
    expect(DNSBL_META['bl.spamcop.net']!.delistUrl(ip)).toContain(ip)
  })

  test('zoneLabel falls back to the raw zone name', () => {
    expect(zoneLabel('zen.spamhaus.org')).toBe('Spamhaus ZEN')
    expect(zoneLabel('unknown.example.org')).toBe('unknown.example.org')
  })
})

describe('buildListings', () => {
  test('returns label + delistUrl + reason per listed zone', () => {
    const listings = buildListings(['zen.spamhaus.org', 'b.barracudacentral.org'], '203.0.113.10')
    expect(listings).toHaveLength(2)
    expect(listings[0]).toEqual({
      zone: 'zen.spamhaus.org',
      label: 'Spamhaus ZEN',
      delistUrl: 'https://check.spamhaus.org/results?query=203.0.113.10',
      reason: DNSBL_META['zen.spamhaus.org']!.reason,
    })
    expect(listings[1]!.delistUrl).toBe('https://www.barracudacentral.org/rbl/removal-request')
  })

  test('an unknown zone yields null url/reason but keeps the zone', () => {
    const [only] = buildListings(['unknown.example.org'], '203.0.113.10')
    expect(only).toEqual({ zone: 'unknown.example.org', label: 'unknown.example.org', delistUrl: null, reason: null })
  })

  test('empty input yields an empty list', () => {
    expect(buildListings([], '203.0.113.10')).toEqual([])
  })
})
