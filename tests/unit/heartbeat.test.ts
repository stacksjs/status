import { describe, expect, test } from 'bun:test'
import { evaluateHeartbeat, isPingKind, isValidCron, nextExpectedPingMs, runDurationSeconds } from '../../app/lib/heartbeat'

const MIN = 60_000
const T0 = 1_700_000_000_000 // fixed epoch; the logic never reads the wall clock

function state(overrides: Partial<Parameters<typeof evaluateHeartbeat>[0]> = {}) {
  return {
    createdAtMs: T0,
    lastPingAtMs: T0,
    lastStartedAtMs: null,
    expectedIntervalSeconds: 3600, // hourly
    graceSeconds: 300, // 5 min
    ...overrides,
  }
}

describe('evaluateHeartbeat (stacksjs/status#1)', () => {
  test('healthy while inside cadence + grace of the last ping', () => {
    expect(evaluateHeartbeat(state(), T0 + 60 * MIN).down).toBe(false)
    // 60m + 5m grace = 65m deadline; 64m is still fine.
    expect(evaluateHeartbeat(state(), T0 + 64 * MIN).down).toBe(false)
  })

  test('missed once cadence + grace elapses with no ping', () => {
    const v = evaluateHeartbeat(state(), T0 + 66 * MIN)
    expect(v).toEqual({ down: true, reason: 'missed' })
  })

  test('never-pinged monitor is overdue from its creation time', () => {
    const s = state({ lastPingAtMs: null })
    expect(evaluateHeartbeat(s, T0 + 64 * MIN).down).toBe(false)
    expect(evaluateHeartbeat(s, T0 + 66 * MIN)).toEqual({ down: true, reason: 'missed' })
  })

  test('a start with no success goes down at start + grace (overrun), before the interval', () => {
    // Started at T0, last success also T0. Grace 5m. Overrun deadline = T0+5m,
    // well before the 65m missed deadline.
    const s = state({ lastStartedAtMs: T0, lastPingAtMs: T0 - 1 })
    expect(evaluateHeartbeat(s, T0 + 4 * MIN).down).toBe(false)
    expect(evaluateHeartbeat(s, T0 + 6 * MIN)).toEqual({ down: true, reason: 'overrun' })
  })

  test('a success after the start clears the in-flight run (no overrun)', () => {
    // Start at T0, success at T0+2m. Not in flight anymore.
    const s = state({ lastStartedAtMs: T0, lastPingAtMs: T0 + 2 * MIN })
    expect(evaluateHeartbeat(s, T0 + 10 * MIN).down).toBe(false)
  })

  test('overrun takes precedence over missed when both would fire', () => {
    // Stale last success (2h ago) AND a fresh start 6m ago: overrun reason wins.
    const s = state({ lastPingAtMs: T0 - 120 * MIN, lastStartedAtMs: T0 - 6 * MIN })
    expect(evaluateHeartbeat(s, T0)).toEqual({ down: true, reason: 'overrun' })
  })
})

describe('runDurationSeconds', () => {
  test('measures a bracketed run in whole seconds', () => {
    expect(runDurationSeconds(T0, T0 + 42_000)).toBe(42)
  })
  test('null when there was no start to measure against', () => {
    expect(runDurationSeconds(null, T0)).toBeNull()
  })
  test('null when the clocks disagree (success earlier than start)', () => {
    expect(runDurationSeconds(T0, T0 - 1000)).toBeNull()
  })
})

describe('cron-expression cadence', () => {
  const at2am = Date.parse('2026-07-08T02:00:00.000Z')
  const daily2am = '0 2 * * *'

  function cronState(overrides = {}) {
    return {
      createdAtMs: at2am,
      lastPingAtMs: at2am,
      lastStartedAtMs: null,
      // A large interval that must NOT be what fires — proves cron wins.
      expectedIntervalSeconds: 999_999,
      graceSeconds: 300,
      cronExpression: daily2am,
      ...overrides,
    }
  }

  test('nextExpectedPingMs follows the cron schedule, not the interval', () => {
    // Next 2am after a 2am ping is the following day.
    expect(nextExpectedPingMs(cronState(), at2am)).toBe(Date.parse('2026-07-09T02:00:00.000Z'))
  })

  test('healthy until the next scheduled slot + grace, then missed', () => {
    // Noon the same day: the next expected slot is tomorrow 2am — fine.
    expect(evaluateHeartbeat(cronState(), Date.parse('2026-07-08T12:00:00Z')).down).toBe(false)
    // 10 minutes past tomorrow's 2am with a 5-minute grace — missed.
    expect(evaluateHeartbeat(cronState(), Date.parse('2026-07-09T02:10:00Z'))).toEqual({ down: true, reason: 'missed' })
  })

  test('an unparseable cron expression fails safe to the interval deadline', () => {
    const s = cronState({ cronExpression: 'not a cron', expectedIntervalSeconds: 300, graceSeconds: 60 })
    // Inside interval + grace (300+60=360s): still up.
    expect(evaluateHeartbeat(s, at2am + 359_000).down).toBe(false)
    // Past it: down via the interval fallback, not left up forever.
    expect(evaluateHeartbeat(s, at2am + 361_000)).toEqual({ down: true, reason: 'missed' })
  })

  test('isValidCron accepts expressions and nicknames, rejects garbage', () => {
    expect(isValidCron('0 2 * * *')).toBe(true)
    expect(isValidCron('@daily')).toBe(true)
    expect(isValidCron('*/15 * * * *')).toBe(true)
    expect(isValidCron('not a cron')).toBe(false)
    expect(isValidCron('99 * * * *')).toBe(false)
  })
})

describe('isPingKind', () => {
  test('accepts only start and fail', () => {
    expect(isPingKind('start')).toBe(true)
    expect(isPingKind('fail')).toBe(true)
    expect(isPingKind('success')).toBe(false)
    expect(isPingKind('')).toBe(false)
    expect(isPingKind(undefined)).toBe(false)
  })
})
