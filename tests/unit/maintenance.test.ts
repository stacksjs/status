import { describe, expect, test } from 'bun:test'
import { expandWindowIntervals, inAnyInterval } from '../../app/lib/maintenance'

describe('inAnyInterval', () => {
  const intervals = [{ startMs: 100, endMs: 200 }, { startMs: 500, endMs: 600 }]

  test('matches inside an interval, inclusive of both bounds', () => {
    expect(inAnyInterval(150, intervals)).toBe(true)
    expect(inAnyInterval(100, intervals)).toBe(true) // start inclusive
    expect(inAnyInterval(200, intervals)).toBe(true) // end inclusive
    expect(inAnyInterval(550, intervals)).toBe(true)
  })

  test('does not match outside every interval', () => {
    expect(inAnyInterval(99, intervals)).toBe(false)
    expect(inAnyInterval(300, intervals)).toBe(false)
    expect(inAnyInterval(601, intervals)).toBe(false)
  })

  test('an empty interval list never matches', () => {
    expect(inAnyInterval(150, [])).toBe(false)
  })
})

describe('expandWindowIntervals (stacksjs/status#1)', () => {
  // Anchor: a 30-minute window starting Sunday 2026-07-05 02:00 UTC.
  const oneOff = { starts_at: '2026-07-05T02:00:00.000Z', ends_at: '2026-07-05T02:30:00.000Z' }
  const day = 86_400_000

  test('a one-off window yields its single interval when it overlaps the range', () => {
    const from = Date.parse('2026-07-01T00:00:00Z')
    const to = Date.parse('2026-07-10T00:00:00Z')
    expect(expandWindowIntervals(oneOff, from, to)).toEqual([
      { startMs: Date.parse('2026-07-05T02:00:00Z'), endMs: Date.parse('2026-07-05T02:30:00Z') },
    ])
  })

  test('a one-off window outside the range yields nothing', () => {
    const from = Date.parse('2026-08-01T00:00:00Z')
    const to = Date.parse('2026-08-10T00:00:00Z')
    expect(expandWindowIntervals(oneOff, from, to)).toEqual([])
  })

  test('a weekly recurrence yields one occurrence per week across the range', () => {
    // Every Sunday 02:00 UTC, 30-minute duration.
    const win = { ...oneOff, recurrence_cron: '0 2 * * 0' }
    const from = Date.parse('2026-07-05T00:00:00Z')
    const to = Date.parse('2026-07-26T12:00:00Z') // covers Jul 5, 12, 19, 26 Sundays
    const ivs = expandWindowIntervals(win, from, to)
    expect(ivs.map(i => new Date(i.startMs).toISOString())).toEqual([
      '2026-07-05T02:00:00.000Z',
      '2026-07-12T02:00:00.000Z',
      '2026-07-19T02:00:00.000Z',
      '2026-07-26T02:00:00.000Z',
    ])
    // Each occurrence keeps the anchor's 30-minute duration.
    expect(ivs[0]!.endMs - ivs[0]!.startMs).toBe(30 * 60_000)
  })

  test('an occurrence in progress at the range start is included', () => {
    const win = { ...oneOff, recurrence_cron: '0 2 * * 0' }
    // Range begins 10 min into the Sunday window; that occurrence still counts.
    const from = Date.parse('2026-07-05T02:10:00Z')
    const to = Date.parse('2026-07-05T12:00:00Z')
    const ivs = expandWindowIntervals(win, from, to)
    expect(ivs.length).toBe(1)
    expect(new Date(ivs[0]!.startMs).toISOString()).toBe('2026-07-05T02:00:00.000Z')
  })

  test('a daily recurrence yields one occurrence per day', () => {
    const win = { starts_at: '2026-07-05T02:00:00Z', ends_at: '2026-07-05T02:15:00Z', recurrence_cron: '0 2 * * *' }
    const from = Date.parse('2026-07-05T00:00:00Z')
    // Range ends Jul 8 00:00, so the 02:00 slots on Jul 5, 6, 7 fall inside it
    // but Jul 8's 02:00 does not.
    const ivs = expandWindowIntervals(win, from, from + 3 * day)
    expect(ivs.length).toBe(3)
  })

  test('an unparseable recurrence falls back to the one-off interval (fail-safe)', () => {
    const win = { ...oneOff, recurrence_cron: 'not a cron' }
    const from = Date.parse('2026-07-01T00:00:00Z')
    const to = Date.parse('2026-07-10T00:00:00Z')
    expect(expandWindowIntervals(win, from, to)).toEqual([
      { startMs: Date.parse('2026-07-05T02:00:00Z'), endMs: Date.parse('2026-07-05T02:30:00Z') },
    ])
  })

  test('a window with a bad timestamp yields nothing', () => {
    expect(expandWindowIntervals({ starts_at: 'nope', ends_at: 'also nope' }, 0, 1e12)).toEqual([])
  })
})
