import { describe, expect, test } from 'bun:test'
import {
  aggregateHostStatus,
  DEFAULT_HOST,
  describeBreaches,
  latestPerHost,
  MAX_HOST_LENGTH,
  normalizeHost,
  readingsFromRows,
} from '../../app/lib/agentHosts'

/**
 * Per-host identity for pushed metrics. The status aggregation is the part
 * that matters: without it, adding the host field would make a two-node
 * monitor flap once a minute.
 */

const NOW = Date.parse('2026-08-18T12:00:00.000Z')

function row(host: string | undefined, status: 'up' | 'down', secondsAgo: number, breaches: string[] = []) {
  return {
    status,
    checked_at: new Date(NOW - secondsAgo * 1000).toISOString(),
    metadata: JSON.stringify({ ...(host === undefined ? {} : { host }), cpuPercent: 12, ramPercent: 34, breaches }),
  }
}

describe('normalizeHost', () => {
  test('keeps an ordinary hostname or FQDN', () => {
    expect(normalizeHost('web-01')).toBe('web-01')
    expect(normalizeHost('web-01.eu.example.com')).toBe('web-01.eu.example.com')
  })

  test('lowercases, so one machine is not two series', () => {
    expect(normalizeHost('Web-01')).toBe('web-01')
  })

  test('sanitizes rather than rejects', () => {
    // The value comes from hostname() on someone else's box. Refusing the
    // sample over a stray character would lose monitoring for cosmetics.
    expect(normalizeHost('  web 01\n')).toBe('web-01')
    // Underscores survive: not valid in a hostname, but Docker generates
    // them, and this is an identifier rather than something we resolve.
    expect(normalizeHost('web_01')).toBe('web_01')
    // A control character must not survive into a table cell or a log line.
    expect(normalizeHost('web\u0000\u001B[31m01')).toBe('web-31m01')
  })

  test('caps the length', () => {
    expect(normalizeHost('a'.repeat(200))).toHaveLength(MAX_HOST_LENGTH)
  })

  test('anything unusable becomes the default host', () => {
    // Agents predating the field send nothing, and must keep behaving
    // exactly as they did.
    expect(normalizeHost(undefined)).toBe(DEFAULT_HOST)
    expect(normalizeHost('')).toBe(DEFAULT_HOST)
    expect(normalizeHost('---')).toBe(DEFAULT_HOST)
    expect(normalizeHost(42)).toBe(DEFAULT_HOST)
    expect(normalizeHost(null)).toBe(DEFAULT_HOST)
  })
})

describe('readingsFromRows', () => {
  test('parses host, status, breaches and metrics', () => {
    const [reading] = readingsFromRows([row('web-01', 'down', 30, ['CPU 96% ≥ 90%'])])

    expect(reading!.host).toBe('web-01')
    expect(reading!.status).toBe('degraded')
    expect(reading!.breaches).toEqual(['CPU 96% ≥ 90%'])
    expect(reading!.cpuPercent).toBe(12)
  })

  test('a row with unreadable metadata still counts as a reading', () => {
    // Its status is known even when its body is not; dropping it would let a
    // corrupt row silently clear an outage.
    const [reading] = readingsFromRows([{ status: 'down', metadata: 'not json', checked_at: new Date(NOW).toISOString() }])

    expect(reading!.status).toBe('degraded')
    expect(reading!.host).toBe(DEFAULT_HOST)
    expect(reading!.cpuPercent).toBeNull()
  })

  test('a row without a usable timestamp is skipped', () => {
    expect(readingsFromRows([{ status: 'up', metadata: '{}', checked_at: null }])).toHaveLength(0)
  })
})

describe('latestPerHost', () => {
  test('one reading per host, newest first', () => {
    const readings = readingsFromRows([
      row('web-01', 'up', 30),
      row('web-01', 'down', 90),
      row('web-02', 'up', 10),
    ])

    const latest = latestPerHost(readings)

    expect(latest.map(r => r.host)).toEqual(['web-02', 'web-01'])
    expect(latest[1]!.status).toBe('up')
  })
})

describe('aggregateHostStatus', () => {
  test('one breaching host degrades the whole monitor', () => {
    const fleet = aggregateHostStatus(readingsFromRows([
      row('web-01', 'up', 20),
      row('web-02', 'down', 10, ['CPU 96% ≥ 90%']),
    ]), NOW, 300)

    expect(fleet.status).toBe('degraded')
    expect(fleet.breaching.map(r => r.host)).toEqual(['web-02'])
    expect(fleet.hosts).toHaveLength(2)
  })

  test('a healthy push from another node does not clear a breach', () => {
    // The flapping this function exists to prevent: without it, web-01's
    // healthy sample every minute would resolve web-02's incident, and
    // web-02's next sample would reopen it.
    const fleet = aggregateHostStatus(readingsFromRows([
      row('web-01', 'up', 5),
      row('web-02', 'down', 40, ['memory 97% ≥ 90%']),
    ]), NOW, 300)

    expect(fleet.status).toBe('degraded')
  })

  test('a host recovers only when its own latest sample is healthy', () => {
    const fleet = aggregateHostStatus(readingsFromRows([
      row('web-02', 'up', 5),
      row('web-02', 'down', 65, ['memory 97% ≥ 90%']),
      row('web-01', 'up', 10),
    ]), NOW, 300)

    expect(fleet.status).toBe('up')
  })

  test('a host that stopped pushing does not pin the monitor down forever', () => {
    // Decommissioned, rebuilt, or renamed. Its last word was "down", but a
    // stale verdict with no way to clear it is a monitor nobody can use.
    // Silence is CheckStaleMetrics' business, not this function's.
    const fleet = aggregateHostStatus(readingsFromRows([
      row('web-01', 'up', 10),
      row('gone-01', 'down', 3600, ['CPU 99% ≥ 90%']),
    ]), NOW, 300)

    expect(fleet.status).toBe('up')
    expect(fleet.hosts.map(r => r.host)).toEqual(['web-01'])
  })

  test('a single anonymous agent behaves exactly as before', () => {
    const fleet = aggregateHostStatus(readingsFromRows([row(undefined, 'down', 10, ['CPU 96% ≥ 90%'])]), NOW, 300)

    expect(fleet.status).toBe('degraded')
    expect(fleet.hosts[0]!.host).toBe(DEFAULT_HOST)
  })
})

describe('describeBreaches', () => {
  test('names the host so the pager says where to look', () => {
    const readings = readingsFromRows([
      row('web-02', 'down', 10, ['CPU 96% ≥ 90%']),
      row('web-03', 'down', 20, ['disk 91% ≥ 85%']),
    ])

    expect(describeBreaches(readings)).toBe('web-02: CPU 96% ≥ 90% | web-03: disk 91% ≥ 85%')
  })

  test('the anonymous host is not named, keeping old messages unchanged', () => {
    const readings = readingsFromRows([row(undefined, 'down', 10, ['CPU 96% ≥ 90%'])])

    expect(describeBreaches(readings)).toBe('CPU 96% ≥ 90%')
  })
})
