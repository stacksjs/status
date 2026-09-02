import { describe, expect, test } from 'bun:test'
import { checkPillClass, coerceHealthReport, evaluateAppHealth, isAppHealthReport, isStacksHealthReport, isStacksProbeReport, parseFinishedAt } from '../../app/lib/appHealth'

/** The example straight out of Oh Dear's docs, so the shape stays honest. */
const NOW = Date.parse('2021-12-07T12:23:53.000Z')
const FRESH = String(Math.floor(NOW / 1000) - 30)

function report(checks: Array<Record<string, unknown>>, finishedAt: unknown = FRESH) {
  return { finishedAt, checkResults: checks }
}

const okCheck = { name: 'DatabaseCheck', label: 'Database', status: 'ok', notificationMessage: '', shortSummary: 'reachable', meta: {} }
const diskFailed = {
  name: 'UsedDiskSpace',
  label: 'Used Disk Space',
  status: 'failed',
  notificationMessage: 'The disk is almost full (91% used)',
  shortSummary: '91%',
  meta: { disk_space_used_percentage: 91 },
}

describe('isAppHealthReport', () => {
  test('only a checkResults array claims the schema', () => {
    expect(isAppHealthReport({ checkResults: [] })).toBe(true)
    expect(isAppHealthReport(report([okCheck]))).toBe(true)
  })

  test('an ordinary health endpoint keeps its own meaning', () => {
    // The legacy `{ status, checks }` contract must not be swallowed by this.
    expect(isAppHealthReport({ status: 'ok', checks: { db: true } })).toBe(false)
    expect(isAppHealthReport({ checkResults: 'nope' })).toBe(false)
    expect(isAppHealthReport(null)).toBe(false)
    expect(isAppHealthReport('{}')).toBe(false)
  })
})

describe('parseFinishedAt', () => {
  test('accepts the unix-seconds string spatie actually sends', () => {
    expect(parseFinishedAt('1638879833')).toBe(1_638_879_833_000)
  })

  test('accepts numbers in seconds or milliseconds, and ISO dates', () => {
    expect(parseFinishedAt(1_638_879_833)).toBe(1_638_879_833_000)
    expect(parseFinishedAt(1_638_879_833_000)).toBe(1_638_879_833_000)
    expect(parseFinishedAt('2021-12-07T12:23:53.000Z')).toBe(Date.parse('2021-12-07T12:23:53.000Z'))
  })

  test('null rather than a guess when absent or unintelligible', () => {
    expect(parseFinishedAt(undefined)).toBeNull()
    expect(parseFinishedAt('')).toBeNull()
    expect(parseFinishedAt('whenever')).toBeNull()
    expect(parseFinishedAt({})).toBeNull()
  })
})

describe('evaluateAppHealth status mapping', () => {
  test('all ok is up', () => {
    const v = evaluateAppHealth(report([okCheck, { ...okCheck, name: 'Cache', label: 'Cache' }]), NOW)
    expect(v.status).toBe('up')
    expect(v.message).toBe('All 2 checks passing')
  })

  test('failed is down and says which check and why', () => {
    const v = evaluateAppHealth(report([okCheck, diskFailed]), NOW)
    expect(v.status).toBe('down')
    expect(v.message).toContain('Used Disk Space')
    expect(v.message).toContain('91% used')
  })

  test('crashed is down — the check itself threw, which is not health', () => {
    expect(evaluateAppHealth(report([{ ...okCheck, status: 'crashed', notificationMessage: 'boom' }]), NOW).status).toBe('down')
  })

  test('warning is degraded, not down', () => {
    const v = evaluateAppHealth(report([okCheck, { ...diskFailed, status: 'warning', notificationMessage: 'Disk at 80%' }]), NOW)
    expect(v.status).toBe('degraded')
    expect(v.message).toContain('Disk at 80%')
  })

  test('failed outranks warning', () => {
    const v = evaluateAppHealth(report([{ ...okCheck, status: 'warning' }, diskFailed]), NOW)
    expect(v.status).toBe('down')
  })

  test('skipped checks are not evidence either way', () => {
    const v = evaluateAppHealth(report([okCheck, { ...diskFailed, status: 'skipped' }]), NOW)
    expect(v.status).toBe('up')
    // ...but they are still reported, so the UI can show them.
    expect(v.checks).toHaveLength(2)
  })

  test('a report of only skipped checks is up, and says so', () => {
    const v = evaluateAppHealth(report([{ ...okCheck, status: 'skipped' }]), NOW)
    expect(v.status).toBe('up')
    expect(v.message).toBe('All checks skipped')
  })

  test('an unrecognized status is down, never silently healthy', () => {
    // A status outside the documented five is a contract violation; treating
    // it as ok would let a typo mark a broken app green.
    const v = evaluateAppHealth(report([{ ...okCheck, status: 'probably-fine' }]), NOW)
    expect(v.status).toBe('down')
    expect(v.message).toContain('unrecognized status')
    expect(v.checks[0]!.status).toBe('unknown')
  })

  test('an empty report is up rather than an error', () => {
    const v = evaluateAppHealth(report([]), NOW)
    expect(v.status).toBe('up')
    expect(v.message).toBe('No checks reported')
  })
})

describe('evaluateAppHealth staleness', () => {
  test('a stale report is down whatever the checks claim', () => {
    // The whole point of the rule: a cached response full of "ok" must not
    // report a long-dead app as healthy.
    const old = String(Math.floor(NOW / 1000) - 900)
    const v = evaluateAppHealth(report([okCheck], old), NOW)
    expect(v.status).toBe('down')
    expect(v.stale).toBe(true)
    expect(v.message).toContain('stale')
  })

  test('inside the window it is trusted', () => {
    const v = evaluateAppHealth(report([okCheck], String(Math.floor(NOW / 1000) - 599)), NOW)
    expect(v.status).toBe('up')
    expect(v.stale).toBe(false)
  })

  test('the max age is configurable', () => {
    const age = String(Math.floor(NOW / 1000) - 120)
    expect(evaluateAppHealth(report([okCheck], age), NOW, 60).status).toBe('down')
    expect(evaluateAppHealth(report([okCheck], age), NOW, 300).status).toBe('up')
  })

  test('no finishedAt is accepted but flagged, not treated as stale', () => {
    const v = evaluateAppHealth({ checkResults: [okCheck] }, NOW)
    expect(v.status).toBe('up')
    expect(v.stale).toBe(false)
    expect(v.finishedAtMs).toBeNull()
  })
})

describe('checkPillClass', () => {
  test('maps each status to the pill the dashboard already uses', () => {
    expect(checkPillClass('ok')).toBe('pill pill-up')
    expect(checkPillClass('warning')).toBe('pill pill-degraded')
    expect(checkPillClass('failed')).toBe('pill pill-down')
    expect(checkPillClass('crashed')).toBe('pill pill-down')
  })

  test('skipped and unknown read muted, never green', () => {
    // A skipped check is not a passing one, and an unrecognized status must
    // not borrow the colour of a healthy one.
    expect(checkPillClass('skipped')).toBe('pill pill-unknown')
    expect(checkPillClass('unknown')).toBe('pill pill-unknown')
  })
})

describe('normalized checks', () => {
  test('carry label, status and summary for display', () => {
    const v = evaluateAppHealth(report([diskFailed]), NOW)
    expect(v.checks[0]).toEqual({
      name: 'UsedDiskSpace',
      label: 'Used Disk Space',
      status: 'failed',
      summary: '91%',
      message: 'The disk is almost full (91% used)',
    })
  })

  test('fall back to the name when label is missing, and survive junk entries', () => {
    const v = evaluateAppHealth(report([{ name: 'Queue', status: 'ok' }, null as any]), NOW)
    expect(v.checks[0]!.label).toBe('Queue')
    expect(v.checks[1]!.name).toBe('unnamed')
    expect(v.checks[1]!.status).toBe('unknown')
  })
})

/**
 * The Stacks dialect.
 *
 * Every Stacks app answers /health from the moment it is created — the
 * framework registers `route.health()` in its default routes and ships a
 * HealthAction — but it answers in its own shape:
 *
 *   { status, timestamp, services: [{ name, status, latency, uptime }] }
 *
 * `isAppHealthReport` rejected that (no `checkResults`), so a health monitor
 * pointed at a Stacks app fell through to the plain-endpoint branch, which
 * reads the body as an opaque 200 and reports up. A critical database went
 * unnoticed. These pin the normalisation that fixed it.
 */
describe('Stacks health reports', () => {
  const STACKS_NOW = Date.parse('2026-08-28T12:00:00.000Z')

  function stacks(services: Array<Record<string, unknown>>, timestamp: unknown = STACKS_NOW - 30_000) {
    return { status: 'ok', timestamp, services }
  }

  test('is recognised, and the Oh Dear shape still is not confused with it', () => {
    expect(isStacksHealthReport(stacks([]))).toBe(true)
    expect(isStacksHealthReport({ status: 'ok' })).toBe(false)
    expect(isStacksHealthReport({ services: 'nope' })).toBe(false)
    expect(isStacksHealthReport(null)).toBe(false)
    // The two dialects must not claim each other.
    expect(isAppHealthReport(stacks([]))).toBe(false)
    expect(isStacksHealthReport(report([okCheck]))).toBe(false)
  })

  test('coerceHealthReport accepts both dialects and rejects anything else', () => {
    expect(coerceHealthReport(report([okCheck]))).not.toBeNull()
    expect(coerceHealthReport(stacks([]))).not.toBeNull()
    expect(coerceHealthReport({ status: 'ok' })).toBeNull()
    expect(coerceHealthReport(null)).toBeNull()
  })

  test('a healthy Stacks app is up', () => {
    const v = evaluateAppHealth(coerceHealthReport(stacks([
      { name: 'API', status: 'healthy', latency: '2ms', uptime: '99.9%' },
      { name: 'Database', status: 'healthy', latency: '12ms', uptime: '99.9%' },
    ]))!, STACKS_NOW)

    expect(v.status).toBe('up')
    expect(v.checks.map(c => c.label)).toEqual(['API', 'Database'])
  })

  test('a critical service is down, not a silent 200 — the whole point', () => {
    const v = evaluateAppHealth(coerceHealthReport(stacks([
      { name: 'API', status: 'healthy', latency: '2ms' },
      { name: 'Database', status: 'critical', latency: '-' },
    ]))!, STACKS_NOW)

    expect(v.status).toBe('down')
    expect(v.message).toContain('Database')
  })

  test('a degraded service is degraded, and carries its latency', () => {
    const v = evaluateAppHealth(coerceHealthReport(stacks([
      { name: 'Database', status: 'degraded', latency: '120ms' },
    ]))!, STACKS_NOW)

    expect(v.status).toBe('degraded')
    expect(v.message).toContain('120ms')
    expect(v.checks[0]!.summary).toBe('120ms')
  })

  test('an unrecognised service status is down, never assumed healthy', () => {
    // Stacks emits healthy/degraded/critical today. Anything new must fail
    // closed rather than be coerced into something safe-looking.
    const v = evaluateAppHealth(coerceHealthReport(stacks([
      { name: 'Queue', status: 'probably-fine' },
    ]))!, STACKS_NOW)

    expect(v.status).toBe('down')
    expect(v.checks[0]!.status).toBe('unknown')
  })

  test('timestamp is read as finishedAt, so staleness works for both dialects', () => {
    const stale = evaluateAppHealth(
      coerceHealthReport(stacks([{ name: 'API', status: 'healthy' }], STACKS_NOW - 3_600_000))!,
      STACKS_NOW,
    )
    expect(stale.status).toBe('down')
    expect(stale.stale).toBe(true)

    const fresh = evaluateAppHealth(
      coerceHealthReport(stacks([{ name: 'API', status: 'healthy' }]))!,
      STACKS_NOW,
    )
    expect(fresh.stale).toBe(false)
    expect(fresh.finishedAtMs).toBe(STACKS_NOW - 30_000)
  })

  test('a services array that is empty or full of junk does not throw', () => {
    expect(evaluateAppHealth(coerceHealthReport(stacks([]))!, STACKS_NOW).status).toBe('up')
    const v = evaluateAppHealth(coerceHealthReport(stacks([null as any, { name: 'API', status: 'healthy' }]))!, STACKS_NOW)
    expect(v.checks).toHaveLength(2)
    expect(v.checks[0]!.name).toBe('unnamed')
  })
})

describe('Stacks probe reports (/api/health)', () => {
  // The shape `route.health()` actually answers, and now the shape every app in
  // the fleet answers. Before this was read, it fell through to the
  // plain-endpoint branch: the verdict was right (the endpoint 503s) but the
  // body naming the broken dependency was thrown away.
  const healthy = {
    app: 'loghq',
    status: 'healthy',
    checks: { database: { ok: true, ms: 1 }, cache: { ok: true, ms: 0 } },
    timestamp: NOW - 5000,
  }

  const cacheDown = {
    app: 'loghq',
    status: 'degraded',
    checks: {
      database: { ok: true, ms: 1 },
      cache: { ok: false, ms: 1500, message: 'timeout' },
    },
    timestamp: NOW - 5000,
  }

  test('a probe map claims the dialect', () => {
    expect(isStacksProbeReport(healthy)).toBe(true)
    expect(isStacksProbeReport(cacheDown)).toBe(true)
  })

  test('the older conventions keep their own meaning', () => {
    // `{ status, checks: { db: true } }` is a different, older contract: the
    // values are booleans, not probe objects. It must not be swallowed here.
    expect(isStacksProbeReport({ status: 'ok', checks: { db: true } })).toBe(false)
    // No probes is no evidence — fall through to the status-code branch.
    expect(isStacksProbeReport({ status: 'healthy', checks: {} })).toBe(false)
    expect(isStacksProbeReport({ checkResults: [] })).toBe(false)
    expect(isStacksProbeReport({ services: [] })).toBe(false)
    expect(isStacksProbeReport(null)).toBe(false)
    expect(isStacksProbeReport('healthy')).toBe(false)
    // A `checks` array is not a probe map.
    expect(isStacksProbeReport({ checks: [{ ok: true }] })).toBe(false)
  })

  test('every probe passing is up', () => {
    const verdict = evaluateAppHealth(coerceHealthReport(healthy)!, NOW)
    expect(verdict.status).toBe('up')
    expect(verdict.checks.map(c => c.name).sort()).toEqual(['cache', 'database'])
  })

  test('a failed probe is down, not degraded', () => {
    // The framework calls the overall status `degraded` when any probe fails.
    // An unreachable dependency is not a partial success, and taking that word
    // at face value would leave the monitor green through an outage.
    const verdict = evaluateAppHealth(coerceHealthReport(cacheDown)!, NOW)
    expect(verdict.status).toBe('down')
  })

  test('the probe message survives, so the page says what broke', () => {
    const verdict = evaluateAppHealth(coerceHealthReport(cacheDown)!, NOW)
    const cache = verdict.checks.find(c => c.name === 'cache')

    expect(cache?.status).toBe('failed')
    expect(cache?.message).toBe('cache check failed: timeout')
    expect(cache?.summary).toBe('1500ms')

    const database = verdict.checks.find(c => c.name === 'database')
    expect(database?.status).toBe('ok')
    expect(database?.summary).toBe('1ms')
  })

  test('timestamp is read as finishedAt, so staleness works here too', () => {
    const stale = { ...healthy, timestamp: NOW - 700_000 }
    const verdict = evaluateAppHealth(coerceHealthReport(stale)!, NOW)

    expect(verdict.stale).toBe(true)
    expect(verdict.status).toBe('down')
  })
})
