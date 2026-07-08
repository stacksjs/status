import { describe, expect, test } from 'bun:test'
import { channelFiresFor, incidentSeverityForType, normalizeFiresOn } from '../../app/lib/notificationSeverity'

describe('incidentSeverityForType', () => {
  test('issue types map to issue, everything else to down', () => {
    for (const t of ['dns_blocklist', 'broken_links', 'lighthouse', 'performance', 'dns'])
      expect(incidentSeverityForType(t)).toBe('issue')
    for (const t of ['uptime', 'ping', 'tcp_port', 'health', 'ssl', 'domain'])
      expect(incidentSeverityForType(t)).toBe('down')
  })
})

describe('normalizeFiresOn', () => {
  test('passes through down/issue, everything else becomes both', () => {
    expect(normalizeFiresOn('down')).toBe('down')
    expect(normalizeFiresOn('issue')).toBe('issue')
    expect(normalizeFiresOn('both')).toBe('both')
    expect(normalizeFiresOn(null)).toBe('both')
    expect(normalizeFiresOn(undefined)).toBe('both')
    expect(normalizeFiresOn('garbage')).toBe('both')
  })
})

describe('channelFiresFor', () => {
  test('both fires for every severity', () => {
    expect(channelFiresFor('both', 'down')).toBe(true)
    expect(channelFiresFor('both', 'issue')).toBe(true)
  })
  test('down only fires for down', () => {
    expect(channelFiresFor('down', 'down')).toBe(true)
    expect(channelFiresFor('down', 'issue')).toBe(false)
  })
  test('issue only fires for issue', () => {
    expect(channelFiresFor('issue', 'issue')).toBe(true)
    expect(channelFiresFor('issue', 'down')).toBe(false)
  })
  test('an absent/invalid preference defaults to firing (both)', () => {
    expect(channelFiresFor(null, 'down')).toBe(true)
    expect(channelFiresFor(undefined, 'issue')).toBe(true)
    expect(channelFiresFor('nonsense', 'down')).toBe(true)
  })
})
