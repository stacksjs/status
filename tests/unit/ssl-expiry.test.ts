import { describe, expect, test } from 'bun:test'
import { crossedThreshold, daysUntilExpiry, isSslIncident, tlsPortFor, WARNING_THRESHOLDS_DAYS, warnAtThreshold } from '../../app/lib/sslExpiry'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-14T12:00:00.000Z')

describe('daysUntilExpiry', () => {
  test('whole days remaining, floored', () => {
    expect(daysUntilExpiry(NOW + 30 * DAY, NOW)).toBe(30)
    // 13 days and 23 hours reads as 13 - it has crossed the 14-day line,
    // which is the conservative direction for a warning.
    expect(daysUntilExpiry(NOW + 14 * DAY - 60 * 60 * 1000, NOW)).toBe(13)
  })

  test('negative once expired', () => {
    expect(daysUntilExpiry(NOW - DAY, NOW)).toBe(-1)
    expect(daysUntilExpiry(NOW - 10 * DAY, NOW)).toBe(-10)
  })
})

describe('crossedThreshold', () => {
  test('returns the tightest threshold crossed', () => {
    expect(crossedThreshold(40)).toBeNull()
    expect(crossedThreshold(31)).toBeNull()
    expect(crossedThreshold(30)).toBe(30) // boundary is inclusive
    expect(crossedThreshold(15)).toBe(30)
    expect(crossedThreshold(14)).toBe(14)
    expect(crossedThreshold(8)).toBe(14)
    expect(crossedThreshold(7)).toBe(7)
    expect(crossedThreshold(2)).toBe(7)
    expect(crossedThreshold(1)).toBe(1)
    expect(crossedThreshold(0)).toBe(1)
  })

  test('an expired certificate has crossed every threshold', () => {
    expect(crossedThreshold(-1)).toBe(1)
    expect(crossedThreshold(-90)).toBe(1)
  })

  test('thresholds are the documented ladder', () => {
    expect(WARNING_THRESHOLDS_DAYS).toEqual([30, 14, 7, 1])
  })
})

describe('warnAtThreshold', () => {
  test('warns on the first check that crosses a threshold', () => {
    expect(warnAtThreshold({ daysUntilExpiry: 12, previousDaysUntilExpiry: null, fingerprintChanged: false })).toBe(14)
  })

  test('stays quiet while inside the same band - the once-per-threshold dedup', () => {
    // 60-second checks for a week must not page 10,000 times.
    expect(warnAtThreshold({ daysUntilExpiry: 12, previousDaysUntilExpiry: 13, fingerprintChanged: false })).toBeNull()
    expect(warnAtThreshold({ daysUntilExpiry: 8, previousDaysUntilExpiry: 14, fingerprintChanged: false })).toBeNull()
  })

  test('warns again when the certificate falls into a tighter band', () => {
    expect(warnAtThreshold({ daysUntilExpiry: 6, previousDaysUntilExpiry: 8, fingerprintChanged: false })).toBe(7)
    expect(warnAtThreshold({ daysUntilExpiry: 1, previousDaysUntilExpiry: 2, fingerprintChanged: false })).toBe(1)
    expect(warnAtThreshold({ daysUntilExpiry: 29, previousDaysUntilExpiry: 31, fingerprintChanged: false })).toBe(30)
  })

  test('stays quiet when the certificate is nowhere near expiry', () => {
    expect(warnAtThreshold({ daysUntilExpiry: 60, previousDaysUntilExpiry: 61, fingerprintChanged: false })).toBeNull()
    expect(warnAtThreshold({ daysUntilExpiry: 31, previousDaysUntilExpiry: null, fingerprintChanged: false })).toBeNull()
  })

  test('a renewal re-arms the ladder', () => {
    // Replacing a cert with another short-lived one deserves its own
    // warning: the old cert's position says nothing about the new one.
    expect(warnAtThreshold({ daysUntilExpiry: 12, previousDaysUntilExpiry: 13, fingerprintChanged: true })).toBe(14)
    // ...but only when the new cert is itself near expiry.
    expect(warnAtThreshold({ daysUntilExpiry: 89, previousDaysUntilExpiry: 2, fingerprintChanged: true })).toBeNull()
  })
})

describe('isSslIncident', () => {
  test('recognizes this job\'s own incidents', () => {
    expect(isSslIncident(JSON.stringify([{ type: 'ssl', message: 'handshake failed' }]))).toBe(true)
    expect(isSslIncident(JSON.stringify([{ type: 'ssl', daysUntilExpiry: -3 }]))).toBe(true)
  })

  test('ignores other check types on the same monitor', () => {
    // An uptime outage and an expired certificate are separate problems:
    // neither may suppress nor resolve the other.
    expect(isSslIncident(JSON.stringify([{ type: 'ai_check' }]))).toBe(false)
    expect(isSslIncident(JSON.stringify([{ type: 'dns_blocklist' }]))).toBe(false)
    expect(isSslIncident(JSON.stringify([{ region: 'us-east' }]))).toBe(false)
  })

  test('malformed or absent metadata fails safe (not ours)', () => {
    // Worst case is opening a second incident - never resolving another
    // check type's incident by accident.
    expect(isSslIncident('not json')).toBe(false)
    expect(isSslIncident('[]')).toBe(false)
    expect(isSslIncident(null)).toBe(false)
    expect(isSslIncident(undefined)).toBe(false)
    expect(isSslIncident('')).toBe(false)
  })
})

describe('tlsPortFor', () => {
  test('uses the URL port when present', () => {
    expect(tlsPortFor(new URL('https://example.com:8443/'))).toBe(8443)
    expect(tlsPortFor(new URL('https://example.com:993/'))).toBe(993)
  })

  test('defaults to 443', () => {
    expect(tlsPortFor(new URL('https://example.com/'))).toBe(443)
    expect(tlsPortFor(new URL('https://example.com/deep/path?q=1'))).toBe(443)
    // A URL parsed from an http:// monitor still probes the TLS default.
    expect(tlsPortFor(new URL('http://example.com/'))).toBe(443)
  })
})
