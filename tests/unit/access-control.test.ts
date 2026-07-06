import { describe, expect, test } from 'bun:test'
import { isEmailDomainAllowed, isIpAllowed } from '../../app/Actions/StatusPages/AccessControl'

describe('isIpAllowed — IPv4', () => {
  test('empty ip or empty ranges fails closed', () => {
    expect(isIpAllowed('', ['203.0.113.5'])).toBe(false)
    expect(isIpAllowed('203.0.113.5', [])).toBe(false)
  })

  test('exact IPv4 match / mismatch', () => {
    expect(isIpAllowed('203.0.113.5', ['203.0.113.5'])).toBe(true)
    expect(isIpAllowed('203.0.113.6', ['203.0.113.5'])).toBe(false)
  })

  test('IPv4 CIDR ranges', () => {
    expect(isIpAllowed('203.0.113.42', ['203.0.113.0/24'])).toBe(true)
    expect(isIpAllowed('203.0.114.1', ['203.0.113.0/24'])).toBe(false)
    expect(isIpAllowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true)
    expect(isIpAllowed('11.1.2.3', ['10.0.0.0/8'])).toBe(false)
    expect(isIpAllowed('8.8.8.8', ['0.0.0.0/0'])).toBe(true) // /0 matches all v4
    expect(isIpAllowed('203.0.113.255', ['203.0.113.128/25'])).toBe(true)
    expect(isIpAllowed('203.0.113.127', ['203.0.113.128/25'])).toBe(false)
  })

  test('IPv4-mapped IPv6 visitor matches an IPv4 allowlist entry', () => {
    expect(isIpAllowed('::ffff:203.0.113.5', ['203.0.113.0/24'])).toBe(true)
    expect(isIpAllowed('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true)
  })

  test('IPv6 loopback is treated as localhost for IPv4 entries', () => {
    expect(isIpAllowed('::1', ['127.0.0.1'])).toBe(true)
  })

  test('malformed IPv4 range is skipped, not a match', () => {
    expect(isIpAllowed('203.0.113.5', ['203.0.113.5/99'])).toBe(false)
    expect(isIpAllowed('203.0.113.5', ['999.0.0.0/8'])).toBe(false)
    expect(isIpAllowed('203.0.113.5', ['nonsense', '203.0.113.5'])).toBe(true)
  })
})

describe('isIpAllowed — IPv6', () => {
  test('exact IPv6 match / mismatch (with :: compression)', () => {
    expect(isIpAllowed('2001:db8::1', ['2001:db8::1'])).toBe(true)
    expect(isIpAllowed('2001:db8::2', ['2001:db8::1'])).toBe(false)
    // Same address, different textual forms both normalize equal.
    expect(isIpAllowed('2001:0db8:0000:0000:0000:0000:0000:0001', ['2001:db8::1'])).toBe(true)
  })

  test('IPv6 CIDR ranges', () => {
    expect(isIpAllowed('2001:db8:1234::abcd', ['2001:db8::/32'])).toBe(true)
    expect(isIpAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false)
    // /48 compares the first three 16-bit groups (2001:0db8:0000).
    expect(isIpAllowed('2001:db8:0:abcd::5', ['2001:db8::/48'])).toBe(true) // 3rd group 0000 matches
    expect(isIpAllowed('2001:db8:1::5', ['2001:db8::/48'])).toBe(false) // 3rd group 0001 differs
    expect(isIpAllowed('fe80::1', ['fe80::/64'])).toBe(true)
    expect(isIpAllowed('2001:db8::1', ['2001:db8::1/128'])).toBe(true)
    expect(isIpAllowed('2001:db8::2', ['2001:db8::1/128'])).toBe(false)
    expect(isIpAllowed('abcd::1', ['::/0'])).toBe(true) // /0 matches all v6
  })

  test('IPv6 loopback matches an IPv6 loopback range', () => {
    expect(isIpAllowed('::1', ['::1/128'])).toBe(true)
    expect(isIpAllowed('::1', ['::/0'])).toBe(true)
  })

  test('IPv4-mapped visitor also matches an IPv4-mapped IPv6 range', () => {
    expect(isIpAllowed('::ffff:192.168.1.5', ['::ffff:0:0/96'])).toBe(true)
    expect(isIpAllowed('::ffff:192.168.1.5', ['::ffff:192.168.0.0/112'])).toBe(true)
  })

  test('families do not cross: v4 visitor never matches a v6 range and vice versa', () => {
    expect(isIpAllowed('203.0.113.5', ['2001:db8::/32'])).toBe(false)
    expect(isIpAllowed('2001:db8::1', ['203.0.113.0/24'])).toBe(false)
  })

  test('mixed allowlist matches the visitor within its own family', () => {
    const list = ['203.0.113.0/24', '2001:db8::/32']
    expect(isIpAllowed('203.0.113.9', list)).toBe(true)
    expect(isIpAllowed('2001:db8::9', list)).toBe(true)
    expect(isIpAllowed('198.51.100.9', list)).toBe(false)
    expect(isIpAllowed('2001:dead::9', list)).toBe(false)
  })

  test('malformed IPv6 is rejected, not matched', () => {
    expect(isIpAllowed('2001:db8:::1', ['::/0'])).toBe(false) // triple colon
    expect(isIpAllowed('2001:db8::1::2', ['::/0'])).toBe(false) // two "::"
    expect(isIpAllowed('gggg::1', ['::/0'])).toBe(false) // bad hex
    expect(isIpAllowed('2001:db8::1', ['2001:db8::/129'])).toBe(false) // bad prefix
    expect(isIpAllowed('2001:db8::1', ['2001:db8::/-1'])).toBe(false)
    // too many groups (9)
    expect(isIpAllowed('1:2:3:4:5:6:7:8:9', ['::/0'])).toBe(false)
  })

  test('embedded-IPv4 forms parse consistently', () => {
    expect(isIpAllowed('::ffff:1.2.3.4', ['::ffff:1.2.3.4/128'])).toBe(true)
    expect(isIpAllowed('64:ff9b::1.2.3.4', ['64:ff9b::/96'])).toBe(true)
  })
})

describe('isEmailDomainAllowed (unchanged, sanity)', () => {
  test('domain matching', () => {
    expect(isEmailDomainAllowed('a@acme.com', ['acme.com'])).toBe(true)
    expect(isEmailDomainAllowed('a@evil.com', ['acme.com'])).toBe(false)
    expect(isEmailDomainAllowed('a@ACME.com', ['acme.com'])).toBe(true)
    expect(isEmailDomainAllowed('no-at', ['acme.com'])).toBe(false)
    expect(isEmailDomainAllowed('a@acme.com', [])).toBe(false)
  })
})
