import { describe, expect, test } from 'bun:test'
import { computeUptime } from '../../app/lib/uptime'

/**
 * The bug this module was extracted for: a `health` monitor checked every
 * minute, currently up, showed "90-DAY UPTIME 0.00%" beside a green Up pill
 * and 2170 checks in 24h.
 *
 * The dashboard weighted uptime by DAY and called a day down if it held a
 * single failed check, so three days of existence with one bad minute each
 * produced zero up-days out of three. The public status page and the report
 * emails had always weighted it by check. This file pins the check-weighted
 * behaviour and the reporting decisions that go with it.
 */
const DAY = 86400000
/** Fixed clock: tests must not depend on when they run. */
const NOW = Date.parse('2026-08-26T14:00:00.000Z')

/** n checks on the given day, all with the given status. */
function checks(dayOffset: number, count: number, status: string) {
  const day = new Date(NOW - dayOffset * DAY).toISOString().slice(0, 10)
  return Array.from({ length: count }, (_, i) => ({
    checked_at: `${day}T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
    status,
  }))
}

describe('computeUptime', () => {
  test('one bad minute in a day does not cost the day', () => {
    // The reported bug, at its real scale: 2170 checks, one of them down.
    const rows = [...checks(0, 2169, 'up'), ...checks(0, 1, 'down')]

    const result = computeUptime(rows, 90, [], NOW)

    expect(result.pct!.toFixed(2)).toBe('99.95')
    expect(result.totalChecks).toBe(2170)
  })

  test('three days each holding one failure is not 0%', () => {
    // The exact shape of the screenshot: the old day-weighted math scored
    // this 0.00% because no day was blemish-free.
    const rows = [
      ...checks(0, 999, 'up'), ...checks(0, 1, 'down'),
      ...checks(1, 999, 'up'), ...checks(1, 1, 'down'),
      ...checks(2, 999, 'up'), ...checks(2, 1, 'down'),
    ]

    const result = computeUptime(rows, 90, [], NOW)

    expect(result.pct!.toFixed(2)).toBe('99.90')
    // The day bars still show something went wrong on each of those days —
    // worst-status-wins is deliberate, it is the percentage that was wrong.
    const withData = result.days.filter(d => d.status !== 'unknown')
    expect(withData).toHaveLength(3)
    expect(withData.every(d => d.status === 'down')).toBe(true)
  })

  test('a fully up window is 100% and a fully down one is 0%', () => {
    expect(computeUptime(checks(0, 10, 'up'), 90, [], NOW).pct).toBe(100)
    expect(computeUptime(checks(0, 10, 'down'), 90, [], NOW).pct).toBe(0)
  })

  test('no checks at all reports null, not zero', () => {
    // 0% and "never measured" are different answers, and rendering the second
    // as the first is how a brand-new monitor looks like a broken one.
    const result = computeUptime([], 90, [], NOW)
    expect(result.pct).toBeNull()
    expect(result.days.every(d => d.status === 'unknown')).toBe(true)
  })

  test('today is inside the window', () => {
    // The status page's buckets used to end at yesterday, so every check that
    // landed today counted toward neither the bars nor the percentage.
    const result = computeUptime(checks(0, 5, 'up'), 90, [], NOW)

    expect(result.totalChecks).toBe(5)
    expect(result.days[result.days.length - 1].day).toBe(new Date(NOW).toISOString().slice(0, 10))
    expect(result.days[result.days.length - 1].total).toBe(5)
  })

  test('the window is exactly the requested number of days', () => {
    const result = computeUptime([], 90, [], NOW)
    expect(result.days).toHaveLength(90)
    expect(result.days[0].day).toBe(new Date(NOW - 89 * DAY).toISOString().slice(0, 10))
  })

  test('checks older than the window are excluded', () => {
    const rows = [...checks(0, 10, 'up'), ...checks(120, 500, 'down')]
    const result = computeUptime(rows, 90, [], NOW)
    expect(result.totalChecks).toBe(10)
    expect(result.pct).toBe(100)
  })

  test('degraded does not cost uptime', () => {
    // A degraded check answered. For a server monitor, degraded IS a CPU/RAM/
    // disk threshold breach, so counting it made a box at 51% against a 50%
    // threshold cost as much uptime as a box that was switched off. It also
    // contradicted features/performance-monitoring.stx, which promises
    // prospects a degradation leaves "your uptime percentage untouched".
    const result = computeUptime([...checks(0, 90, 'up'), ...checks(0, 10, 'degraded')], 90, [], NOW)
    expect(result.pct).toBe(100)
  })

  test('down still costs uptime', () => {
    // The distinction the whole change rests on: unreachable is not busy.
    const result = computeUptime([...checks(0, 90, 'up'), ...checks(0, 10, 'down')], 90, [], NOW)
    expect(result.pct).toBe(90)
  })

  test('a degraded day outranks an up day but not a down one', () => {
    const degraded = computeUptime([...checks(0, 9, 'up'), ...checks(0, 1, 'degraded')], 90, [], NOW)
    expect(degraded.days[degraded.days.length - 1].status).toBe('degraded')

    const down = computeUptime([...checks(0, 8, 'up'), ...checks(0, 1, 'degraded'), ...checks(0, 1, 'down')], 90, [], NOW)
    expect(down.days[down.days.length - 1].status).toBe('down')
  })

  test('maintenance windows are excluded from both the bars and the percentage', () => {
    // docs/operate/maintenance.md: a planned outage must not dent uptime.
    const today = new Date(NOW).toISOString().slice(0, 10)
    const rows = [
      { checked_at: `${today}T02:00:00.000Z`, status: 'down' },
      { checked_at: `${today}T02:30:00.000Z`, status: 'down' },
      { checked_at: `${today}T09:00:00.000Z`, status: 'up' },
    ]
    const window = [{ startMs: Date.parse(`${today}T01:00:00.000Z`), endMs: Date.parse(`${today}T03:00:00.000Z`) }]

    const result = computeUptime(rows, 90, window, NOW)

    expect(result.totalChecks).toBe(1)
    expect(result.pct).toBe(100)
    expect(result.days[result.days.length - 1].status).toBe('up')
  })

  test('an unrecognised status never skews the denominator', () => {
    const today = new Date(NOW).toISOString().slice(0, 10)
    const rows = [
      { checked_at: `${today}T01:00:00.000Z`, status: 'up' },
      { checked_at: `${today}T02:00:00.000Z`, status: 'pending' },
    ]
    const result = computeUptime(rows, 90, [], NOW)
    expect(result.totalChecks).toBe(1)
    expect(result.pct).toBe(100)
  })

  test('rows in any order give the same answer', () => {
    const ordered = [...checks(2, 5, 'up'), ...checks(1, 5, 'down'), ...checks(0, 5, 'up')]
    const shuffled = [...ordered].reverse()
    expect(computeUptime(shuffled, 90, [], NOW).pct).toBe(computeUptime(ordered, 90, [], NOW).pct)
  })
})
