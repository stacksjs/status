import { describe, expect, test } from 'bun:test'
import { inAnyInterval } from '../../app/lib/maintenance'

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
