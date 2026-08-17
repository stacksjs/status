import { describe, expect, test } from 'bun:test'
import { describeCadence, evaluateHeartbeat, formatDurationSeconds, isPingKind, isValidCron, nextExpectedPingMs, pingUrls, runDurationSeconds, summarizeHeartbeat } from '../../app/lib/heartbeat'

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

describe('pingUrls', () => {
  test('carries the /api prefix the route loader adds', () => {
    // routes/api.ts declares '/ping/{token}' but is mounted under /api. A URL
    // without the prefix 404s, records nothing, and the monitor then pages the
    // customer for a check-in their job genuinely made.
    const urls = pingUrls('https://statushq.org', 'tok123')
    expect(urls.success).toBe('https://statushq.org/api/ping/tok123')
    expect(urls.start).toBe('https://statushq.org/api/ping/tok123/start')
    expect(urls.fail).toBe('https://statushq.org/api/ping/tok123/fail')
  })

  test('tolerates a trailing slash on APP_URL', () => {
    expect(pingUrls('http://localhost:3000/', 'abc').success).toBe('http://localhost:3000/api/ping/abc')
  })
})

describe('formatDurationSeconds', () => {
  test('reads as whole units at each scale', () => {
    expect(formatDurationSeconds(45)).toBe('45s')
    expect(formatDurationSeconds(300)).toBe('5m')
    expect(formatDurationSeconds(90)).toBe('1m 30s')
    expect(formatDurationSeconds(3600)).toBe('1h')
    expect(formatDurationSeconds(5400)).toBe('1h 30m')
    expect(formatDurationSeconds(86_400)).toBe('1d')
    expect(formatDurationSeconds(180_000)).toBe('2d 2h')
  })

  test('an em dash rather than "null seconds" when nothing was measured', () => {
    expect(formatDurationSeconds(null)).toBe('—')
    expect(formatDurationSeconds(undefined)).toBe('—')
    expect(formatDurationSeconds(Number.NaN)).toBe('—')
  })
})

describe('describeCadence', () => {
  test('a valid cron expression is what drives the deadline, so it is what is shown', () => {
    expect(describeCadence({ expectedIntervalSeconds: 999_999, cronExpression: '0 2 * * *' })).toBe('cron 0 2 * * * (UTC)')
    expect(describeCadence({ expectedIntervalSeconds: 999_999, cronExpression: '@daily' })).toBe('cron @daily (UTC)')
  })

  test('plain interval when no expression is set', () => {
    expect(describeCadence({ expectedIntervalSeconds: 3600, cronExpression: null })).toBe('every 1h')
    expect(describeCadence({ expectedIntervalSeconds: 3600 })).toBe('every 1h')
  })

  test('an invalid expression says so — otherwise the interval fallback is invisible', () => {
    // nextExpectedPingMs fails safe to the interval; a card that just printed
    // the typo'd expression would claim a schedule nothing enforces.
    expect(describeCadence({ expectedIntervalSeconds: 300, cronExpression: 'not a cron' }))
      .toBe('every 5m (cron expression "not a cron" is not valid — ignored)')
  })
})

describe('summarizeHeartbeat', () => {
  test('agrees with evaluateHeartbeat in every state — the card and the alert are one verdict', () => {
    const cases = [
      state(),
      state({ lastPingAtMs: null }),
      state({ lastStartedAtMs: T0, lastPingAtMs: T0 - 1 }),
      state({ lastPingAtMs: T0 - 120 * MIN, lastStartedAtMs: T0 - 6 * MIN }),
      state({ cronExpression: '0 2 * * *' }),
    ]
    for (const s of cases) {
      for (const now of [T0, T0 + 6 * MIN, T0 + 66 * MIN, T0 + 3000 * MIN]) {
        const verdict = evaluateHeartbeat(s, now)
        const summary = summarizeHeartbeat(s, now)
        expect(summary.down).toBe(verdict.down)
        expect(summary.reason).toBe(verdict.down ? verdict.reason : null)
      }
    }
  })

  test('healthy inside the window, with the deadline the job will use', () => {
    const s = summarizeHeartbeat(state(), T0 + 10 * MIN)
    expect(s.state).toBe('healthy')
    expect(s.down).toBe(false)
    // 60m cadence + 5m grace after the last ping at T0.
    expect(s.dueAtMs).toBe(T0 + 65 * MIN)
    expect(s.dueInSeconds).toBe(55 * 60)
  })

  test('awaiting the first ping is its own state, not a false "healthy"', () => {
    const s = summarizeHeartbeat(state({ lastPingAtMs: null }), T0 + MIN)
    expect(s.state).toBe('awaiting')
    expect(s.awaitingFirstPing).toBe(true)
    expect(s.down).toBe(false)
  })

  test('a started run reads as running and is judged against start + grace', () => {
    const s = summarizeHeartbeat(state({ lastStartedAtMs: T0, lastPingAtMs: T0 - 1 }), T0 + MIN)
    expect(s.state).toBe('running')
    expect(s.inFlight).toBe(true)
    expect(s.dueAtMs).toBe(T0 + 5 * MIN) // grace, not cadence
  })

  test('down states name which deadline was blown', () => {
    expect(summarizeHeartbeat(state(), T0 + 66 * MIN).state).toBe('missed')
    expect(summarizeHeartbeat(state({ lastStartedAtMs: T0, lastPingAtMs: T0 - 1 }), T0 + 6 * MIN).state).toBe('overrun')
  })

  test('dueInSeconds goes negative once the deadline has passed', () => {
    expect(summarizeHeartbeat(state(), T0 + 70 * MIN).dueInSeconds).toBe(-5 * 60)
  })
})
