import { describe, expect, test } from 'bun:test'
import { evaluateAppHealth, isAppHealthReport, parseFinishedAt } from '../../app/lib/appHealth'

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
