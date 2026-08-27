import { describe, expect, test } from 'bun:test'
import { computeUptime, roundMsForInterval } from '../../app/lib/uptime'

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
    // The bars mark each of those days, but as blemished rather than out.
    // They used to be red: worst-status-wins made a 99.9% day look identical
    // to one that was down from midnight, so the strip contradicted the
    // percentage printed directly above it.
    const withData = result.days.filter(d => d.status !== 'unknown')
    expect(withData).toHaveLength(3)
    expect(withData.every(d => d.status === 'degraded')).toBe(true)
  })

  test('a day only reads as down once it loses more than 1% of its checks', () => {
    // The threshold, from both sides. 15 bad minutes out of 1440 is a bad
    // morning; 200 is an outage, and the bar has to be able to say which.
    const blip = computeUptime([...checks(0, 1430, 'up'), ...checks(0, 10, 'down')], 90, [], NOW)
    expect(blip.days[blip.days.length - 1]!.status).toBe('degraded')

    const outage = computeUptime([...checks(0, 1240, 'up'), ...checks(0, 200, 'down')], 90, [], NOW)
    expect(outage.days[outage.days.length - 1]!.status).toBe('down')
  })

  test('a clean day is up, not merely not-down', () => {
    const result = computeUptime(checks(0, 100, 'up'), 90, [], NOW)
    expect(result.days[result.days.length - 1]!.status).toBe('up')
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

  describe('multi-region consensus', () => {
    /**
     * The reported bug: a `health` monitor answering in 375ms, pill green,
     * showing 89.68% uptime with every day that had data painted red.
     *
     * Every probe region writes its own check_results row. The pill goes
     * through EvaluateMonitorConsensus, which needs `minRegionsToConfirm`
     * regions to agree before calling a monitor down — deliberately, "so a
     * single region's network blip can no longer open (or resolve) an
     * incident". Uptime counted the rows flat, so the one region that could
     * not reach the target cost real uptime and reddened the bars, and the
     * number disagreed with the pill beside it.
     */

    /** `count` rounds, `roundMs` apart, each region voting the given status. */
    function rounds(count: number, votes: Record<string, string>, startTs = NOW - 12 * 3600000) {
      const rows: { checked_at: string, status: string, region: string }[] = []
      for (let i = 0; i < count; i++) {
        for (const [region, status] of Object.entries(votes)) {
          // Regions start the same tick a few seconds apart, which is exactly
          // what the greedy grouping has to tolerate.
          const offset = region.length * 900
          rows.push({ checked_at: new Date(startTs + i * 60_000 + offset).toISOString(), status, region })
        }
      }
      return rows
    }

    const ROUND = 30_000

    test('one region failing while the others are fine costs no uptime', () => {
      const rows = rounds(100, { 'us-east': 'up', 'eu-central': 'down', 'ap-south': 'up' })

      const flat = computeUptime(rows, 90, [], NOW)
      const consensus = computeUptime(rows, 90, [], NOW, { roundMs: ROUND, minRegionsToConfirm: 2 })

      // Counting every region's row flat: a third of all checks are "down".
      expect(flat.pct!.toFixed(2)).toBe('66.67')
      // Through consensus: 100 rounds, none of which two regions called down.
      expect(consensus.pct).toBe(100)
      expect(consensus.totalChecks).toBe(100)
      expect(consensus.days[consensus.days.length - 1]!.status).toBe('up')
    })

    test('a real outage still counts when the regions agree', () => {
      // The other half of the guarantee: consensus must not launder a genuine
      // outage into uptime just because it collapses rows.
      const ok = rounds(90, { 'us-east': 'up', 'eu-central': 'up' })
      const bad = rounds(10, { 'us-east': 'down', 'eu-central': 'down' }, NOW - 6 * 3600000)

      const result = computeUptime([...ok, ...bad], 90, [], NOW, { roundMs: ROUND, minRegionsToConfirm: 2 })

      expect(result.totalChecks).toBe(100)
      expect(result.pct).toBe(90)
    })

    test('single-region data is untouched by the round collapsing', () => {
      // Every self-hosted single-box install is this case, so it has to come
      // out byte-identical whether or not the caller passes roundMs.
      const rows = [...checks(0, 90, 'up'), ...checks(0, 10, 'down')]
      const withOpt = computeUptime(rows, 90, [], NOW, { roundMs: ROUND })
      const without = computeUptime(rows, 90, [], NOW)

      expect(withOpt.pct).toBe(without.pct)
      expect(withOpt.totalChecks).toBe(without.totalChecks)
      expect(withOpt.days.map(d => d.status)).toEqual(without.days.map(d => d.status))
    })

    test('rows with no region at all are one region, not many', () => {
      // check_results.region defaults to 'default'; older rows predate the
      // column entirely and arrive undefined. Both are the same region.
      const rows = [
        ...checks(0, 5, 'up').map(r => ({ ...r, region: 'default' })),
        ...checks(0, 5, 'up'),
      ]
      const result = computeUptime(rows, 90, [], NOW, { roundMs: ROUND })
      expect(result.totalChecks).toBe(10)
      expect(result.pct).toBe(100)
    })
  })

  describe('roundMsForInterval', () => {
    test('sits between the region spread and the next tick', () => {
      expect(roundMsForInterval(60)).toBe(30_000)
      expect(roundMsForInterval(30)).toBe(15_000)
      // Clamped: a 30-minute monitor must not swallow separate rounds, and a
      // 5-second one must still leave room for regions to straggle.
      expect(roundMsForInterval(1800)).toBe(30_000)
      expect(roundMsForInterval(5)).toBe(5_000)
    })

    test('a missing or nonsense interval still yields a usable window', () => {
      expect(roundMsForInterval(null)).toBe(30_000)
      expect(roundMsForInterval(undefined)).toBe(30_000)
      expect(roundMsForInterval(0)).toBe(30_000)
    })
  })

  test('rows in any order give the same answer', () => {
    const ordered = [...checks(2, 5, 'up'), ...checks(1, 5, 'down'), ...checks(0, 5, 'up')]
    const shuffled = [...ordered].reverse()
    expect(computeUptime(shuffled, 90, [], NOW).pct).toBe(computeUptime(ordered, 90, [], NOW).pct)
  })
})
