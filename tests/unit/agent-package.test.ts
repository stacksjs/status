import { describe, expect, test } from 'bun:test'
import {
  cpuLoadCheck,
  createHealthHandler,
  defaultChecks,
  metricsEndpoint,
  parseMemAvailable,
  runChecks,
  usedDiskSpaceCheck,
  usedMemoryCheck,
} from '../../packages/agent/src'
import { collect, diskPercent, memory } from '../../packages/agent/src/metrics'

/**
 * @statushq/agent — the collector customers install. Its output feeds
 * /api/agent/{token}/metrics and the spatie-schema health endpoint, so these
 * pin the shapes both consumers rely on.
 */

describe('host metrics', () => {
  test('collect() returns exactly what the ingest endpoint validates', async () => {
    const metrics = await collect({ sampleMs: 50 })
    for (const key of ['cpuPercent', 'ramPercent', 'ramUsedMb', 'ramTotalMb'] as const) {
      expect(typeof metrics[key]).toBe('number')
      expect(Number.isFinite(metrics[key])).toBe(true)
    }
    // The endpoint rejects percentages outside 0-100 and negative MB.
    expect(metrics.cpuPercent).toBeGreaterThanOrEqual(0)
    expect(metrics.cpuPercent).toBeLessThanOrEqual(100)
    expect(metrics.ramPercent).toBeGreaterThanOrEqual(0)
    expect(metrics.ramPercent).toBeLessThanOrEqual(100)
    expect(metrics.ramUsedMb).toBeGreaterThanOrEqual(0)
    expect(metrics.ramTotalMb).toBeGreaterThan(0)
  })

  test('memory() reports used, not free', () => {
    const mem = memory()
    expect(mem.ramUsedMb).toBeLessThanOrEqual(mem.ramTotalMb)
    expect(mem.ramPercent).toBe(Math.min(100, Math.max(0, mem.ramPercent)))
  })

  test('parseMemAvailable reads the kernel field rather than trusting freemem()', () => {
    // freemem() maps to MemFree on Linux, which ignores reclaimable cache and
    // reports a healthy box as ~90% used. MemAvailable is the honest number.
    const meminfo = 'MemTotal:       16316948 kB\nMemFree:          221836 kB\nMemAvailable:   11342928 kB\nBuffers:          123 kB\n'
    expect(parseMemAvailable(meminfo)).toBe(11_342_928 * 1024)
  })

  test('parseMemAvailable returns null when the field is absent', () => {
    expect(parseMemAvailable('MemTotal: 16316948 kB\nMemFree: 221836 kB\n')).toBeNull()
  })

  test('diskPercent is a percentage here and undefined for a bogus mount', () => {
    const pct = diskPercent('/')
    expect(typeof pct).toBe('number')
    expect(pct!).toBeGreaterThanOrEqual(0)
    expect(pct!).toBeLessThanOrEqual(100)
    expect(diskPercent('/definitely/not/a/mount/point')).toBeUndefined()
  })
})

describe('health report', () => {
  test('emits the schema StatusHQ and Oh Dear both read', async () => {
    const report = await runChecks([usedDiskSpaceCheck(), usedMemoryCheck()])
    expect(typeof report.finishedAt).toBe('string')
    expect(/^\d+$/.test(report.finishedAt)).toBe(true)
    for (const check of report.checkResults) {
      for (const field of ['name', 'label', 'status', 'notificationMessage', 'shortSummary', 'meta'] as const)
        expect(check).toHaveProperty(field)
      expect(['ok', 'warning', 'failed', 'crashed', 'skipped']).toContain(check.status)
    }
  })

  test('thresholds decide the status', async () => {
    const failing = await runChecks([usedDiskSpaceCheck({ warning: 0, failure: 0 })])
    expect(failing.checkResults[0]!.status).toBe('failed')
    expect(failing.checkResults[0]!.notificationMessage).toContain('Used disk space')

    const passing = await runChecks([usedDiskSpaceCheck({ warning: 101, failure: 101 })])
    expect(passing.checkResults[0]!.status).toBe('ok')
    expect(passing.checkResults[0]!.notificationMessage).toBe('')
  })

  test('a check that throws is reported as crashed, not fatal', async () => {
    const report = await runChecks([
      () => { throw new Error('redis unreachable') },
      usedMemoryCheck(),
    ])
    expect(report.checkResults[0]!.status).toBe('crashed')
    expect(report.checkResults[0]!.notificationMessage).toContain('redis unreachable')
    // The surviving check still reports — one broken check must not blind the
    // monitor to the rest.
    expect(report.checkResults[1]!.status).not.toBe('crashed')
  })

  test('defaultChecks covers what spatie/laravel-health has no check for', async () => {
    const names = (await runChecks(defaultChecks())).checkResults.map(c => c.name)
    expect(names).toContain('UsedDiskSpace')
    expect(names).toContain('UsedMemory')
    expect(names).toContain('CpuLoad')
  })
})

describe('health handler', () => {
  const handler = createHealthHandler({ checks: [usedMemoryCheck()], secret: 'top-secret' })

  test('serves the report when the secret matches', async () => {
    const response = await handler(new Request('http://localhost/health', {
      headers: { 'oh-dear-health-check-secret': 'top-secret' },
    }))
    expect(response.status).toBe(200)
    const body = await response.json() as { checkResults: unknown[] }
    expect(body.checkResults).toHaveLength(1)
  })

  test('403s on a wrong or missing secret, with no report body', async () => {
    const wrong = await handler(new Request('http://localhost/health', {
      headers: { 'oh-dear-health-check-secret': 'guess' },
    }))
    expect(wrong.status).toBe(403)
    expect(await wrong.text()).not.toContain('checkResults')

    expect((await handler(new Request('http://localhost/health'))).status).toBe(403)
  })

  test('no secret configured serves openly', async () => {
    const open = createHealthHandler({ checks: [usedMemoryCheck()] })
    expect((await open(new Request('http://localhost/health'))).status).toBe(200)
  })
})

describe('metricsEndpoint', () => {
  test('builds the ingest URL, tolerating a trailing slash', () => {
    expect(metricsEndpoint('https://statushq.org', 'tok')).toBe('https://statushq.org/api/agent/tok/metrics')
    expect(metricsEndpoint('https://statushq.org/', 'tok')).toBe('https://statushq.org/api/agent/tok/metrics')
  })
})

describe('cpu check', () => {
  test('samples without blocking the event loop for a second', async () => {
    const report = await runChecks([cpuLoadCheck({ sampleMs: 30 })])
    expect(report.checkResults[0]!.name).toBe('CpuLoad')
    expect(report.checkResults[0]!.meta).toHaveProperty('cpu_used_percentage')
  })
})
