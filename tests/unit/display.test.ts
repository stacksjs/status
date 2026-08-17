import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { formatDateTime, isoDate, relativeTime, siteHost, siteSlug, statusLabel, statusPillClass } from '../../app/lib/display'

/**
 * These helpers replaced 31 copy-pasted definitions across 9 server blocks.
 * The tests pin the behaviours the copies disagreed about, so a future
 * "simplification" can't quietly reintroduce the drift.
 */

describe('statusLabel', () => {
  test('covers every value the monitors.status CHECK allows', () => {
    expect(statusLabel('up')).toBe('Up')
    expect(statusLabel('down')).toBe('Down')
    expect(statusLabel('degraded')).toBe('Degraded')
    expect(statusLabel('paused')).toBe('Paused')
    expect(statusLabel('unknown')).toBe('Unknown')
  })

  test('paused is not swallowed by the fallback', () => {
    // Three of the six former copies had no `paused` branch, so a paused
    // monitor read "Pending" on the monitors list and "Unknown" on a status
    // page while its own detail page said "Paused".
    expect(statusLabel('paused')).not.toBe('Unknown')
  })

  test('unrecognised and missing values read Unknown, matching the pill class', () => {
    expect(statusLabel('sideways')).toBe('Unknown')
    expect(statusLabel(null)).toBe('Unknown')
    expect(statusLabel(undefined)).toBe('Unknown')
    expect(statusPillClass(null)).toBe('pill pill-unknown')
  })
})

describe('statusPillClass', () => {
  test('maps the three coloured states and defaults the rest', () => {
    expect(statusPillClass('up')).toBe('pill pill-up')
    expect(statusPillClass('degraded')).toBe('pill pill-degraded')
    expect(statusPillClass('down')).toBe('pill pill-down')
    expect(statusPillClass('paused')).toBe('pill pill-unknown')
    expect(statusPillClass('unknown')).toBe('pill pill-unknown')
  })
})

describe('relativeTime', () => {
  const NOW = Date.parse('2026-08-17T12:00:00.000Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  test('steps through seconds, minutes, hours, days', () => {
    expect(relativeTime(ago(5_000), 'never', NOW)).toBe('5s ago')
    expect(relativeTime(ago(90_000), 'never', NOW)).toBe('1m ago')
    expect(relativeTime(ago(7_200_000), 'never', NOW)).toBe('2h ago')
    expect(relativeTime(ago(3 * 86_400_000), 'never', NOW)).toBe('3d ago')
  })

  test('clamps future timestamps to 0 rather than rendering negatives', () => {
    expect(relativeTime(new Date(NOW + 60_000).toISOString(), 'never', NOW)).toBe('0s ago')
  })

  test('the empty label is per-call — the copies disagreed on it', () => {
    // Lists said "never"; the monitor detail page said "--".
    expect(relativeTime(null)).toBe('never')
    expect(relativeTime(null, '--')).toBe('--')
    expect(relativeTime('not a date', '--', NOW)).toBe('--')
  })
})

describe('formatDateTime', () => {
  const ISO = '2026-08-17T19:40:00.000Z'

  test('short dashboard form has no year', () => {
    const out = formatDateTime(ISO)
    expect(out).toContain('Aug')
    expect(out).not.toContain('2026')
  })

  test('year is opt-in, for incident permalinks', () => {
    expect(formatDateTime(ISO, { year: true })).toContain('2026')
  })

  test('hour12 is opt-in so a page locale keeps its own convention', () => {
    expect(formatDateTime(ISO, { hour12: false, locale: 'en-US' })).not.toMatch(/AM|PM/)
    expect(formatDateTime(ISO, { hour12: true, locale: 'en-US' })).toMatch(/AM|PM/)
  })

  test('unparseable and missing input render the empty label, never "Invalid Date"', () => {
    // Two of the four former copies passed garbage straight to toLocaleString.
    expect(formatDateTime('nonsense')).toBe('--')
    expect(formatDateTime(null)).toBe('--')
    expect(formatDateTime('', { empty: '' })).toBe('')
    expect(formatDateTime('nonsense')).not.toContain('Invalid')
  })
})

describe('isoDate', () => {
  test('keeps the sortable ISO date, not a localized one', () => {
    expect(isoDate('2026-08-17T19:40:00.000Z')).toBe('2026-08-17')
  })

  test('missing input renders the empty label', () => {
    expect(isoDate(null)).toBe('--')
    expect(isoDate('', 'never')).toBe('never')
  })
})

describe('the browser copy in monitors/index.stx', () => {
  /**
   * The live-update script rewrites the same status cell the server rendered.
   * It cannot import app/ TS, so it carries a hand-written copy of these two
   * helpers — and that copy had already drifted (no `paused` branch, a
   * "Pending" fallback), which would have shown up as a label that flipped
   * the moment a WebSocket update arrived. These tests evaluate the copy
   * straight out of the view and require it to agree with the module.
   */
  const VIEW = readFileSync(resolve(import.meta.dir, '../../resources/views/dashboard/monitors/index.stx'), 'utf8')
  const STATUSES = ['up', 'down', 'degraded', 'paused', 'unknown', 'something-else']

  /** Pull a `function name(...) {...}` out of the client script and compile it. */
  function clientFn(name: string): (status: string) => string {
    const client = VIEW.slice(VIEW.lastIndexOf('<script>'))
    const start = client.indexOf(`function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    let i = client.indexOf('{', start)
    const from = i
    for (; i < client.length; i++) {
      if (client[i] === '{')
        depth++
      else if (client[i] === '}' && --depth === 0)
        break
    }
    // eslint-disable-next-line no-new-func
    return new Function(`${client.slice(start, i + 1)}; return ${name}`)() as (status: string) => string
  }

  test('its stLabel agrees with statusLabel for every status', () => {
    const clientLabel = clientFn('stLabel')
    for (const status of STATUSES)
      expect([status, clientLabel(status)]).toEqual([status, statusLabel(status)])
  })

  test('its stClass agrees with statusPillClass for every status', () => {
    const clientClass = clientFn('stClass')
    for (const status of STATUSES)
      expect([status, clientClass(status)]).toEqual([status, statusPillClass(status)])
  })
})

describe('siteHost / siteSlug', () => {
  test('strips scheme, www, port, path, query and fragment', () => {
    expect(siteHost('https://www.Example.com:8443/health?x=1#f')).toBe('example.com')
    expect(siteHost('http://api.example.com/v1')).toBe('api.example.com')
  })

  test('passes through the bare hostnames that ping/tcp/dns monitors use', () => {
    // new URL() would throw on these, which is why it isn't used.
    expect(siteHost('db.internal')).toBe('db.internal')
    expect(siteHost('example.com')).toBe('example.com')
  })

  test('empty input is "unknown" rather than an empty group key', () => {
    expect(siteHost('')).toBe('unknown')
    expect(siteHost(null)).toBe('unknown')
  })

  test('slugs are url-safe and stable', () => {
    expect(siteSlug('api.example.com')).toBe('api-example-com')
    expect(siteSlug('example.com.')).toBe('example-com')
    expect(siteSlug('')).toBe('')
  })
})
