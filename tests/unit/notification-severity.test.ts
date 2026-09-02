import { describe, expect, test } from 'bun:test'
import { channelFiresFor, incidentSeverity, incidentSeverityForType, normalizeFiresOn } from '../../app/lib/notificationSeverity'

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

describe('incidentSeverity (the incident\'s own marker wins)', () => {
  // Server incidents belong to a box, not to a site, so they carry no monitor
  // type at all — the marker in impacted_checks is the whole classification.
  // Both kinds are issues: a hot box answered, and a silent agent says nothing
  // about whether the sites on it answer. Only a site's own monitor pages as
  // an outage.
  test('a hot box is an issue, with no monitor type to fall back on', () => {
    const marker = JSON.stringify([{ type: 'server_hot', hosts: [{ host: 'web-01', breaches: ['CPU 96% \u2265 90%'] }] }])
    expect(incidentSeverity('', marker)).toBe('issue')
  })

  test('an agent that went quiet is an issue, not an outage', () => {
    const marker = JSON.stringify([{ type: 'server_silent', reason: 'missed_push', windowSeconds: 300 }])
    expect(incidentSeverity('', marker)).toBe('issue')
  })

  test('the pre-Server marker keeps classifying as it always did', () => {
    // Incidents the backfill resolved still render and route amber.
    expect(incidentSeverity('', JSON.stringify([{ type: 'server_metrics', reason: 'missed_push' }]))).toBe('issue')
    expect(incidentSeverity('uptime', JSON.stringify([{ type: 'server_metrics' }]))).toBe('issue')
  })

  test('without a marker the monitor type decides, and unreadable JSON falls back rather than throwing', () => {
    expect(incidentSeverity('uptime', null)).toBe('down')
    expect(incidentSeverity('dns', null)).toBe('issue')
    expect(incidentSeverity('uptime', '{not json')).toBe('down')
    // An unknown marker is not a licence to downgrade an outage.
    expect(incidentSeverity('uptime', JSON.stringify([{ type: 'missed_push' }]))).toBe('down')
  })
})
