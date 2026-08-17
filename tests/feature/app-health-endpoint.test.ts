import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createHealthHandler, usedDiskSpaceCheck, usedMemoryCheck } from '../../packages/agent/src'
import RunHealthCheck from '../../app/Jobs/RunHealthCheck'
import CheckResult from '../../app/Models/CheckResult'
import Monitor from '../../app/Models/Monitor'

/**
 * End-to-end for the spatie/laravel-health + Oh Dear schema: a real endpoint
 * serving `{ finishedAt, checkResults }`, polled by the real job. The point of
 * the schema is drop-in compatibility, so these assert on the payload that
 * package actually emits rather than on a shape of our own invention.
 */

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM_ID = 90021

describe('Application health endpoint (spatie/laravel-health schema)', () => {
  let server: Server
  let responseBody = ''
  let responseStatus = 200
  let lastSecretHeader: string | null = null

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (request) => {
        lastSecretHeader = request.headers.get('oh-dear-health-check-secret')
        return new Response(responseBody, { status: responseStatus, headers: { 'content-type': 'application/json' } })
      },
    })
  })
  afterAll(() => server.stop(true))

  async function cleanup(): Promise<void> {
    for (const monitor of await Monitor.where('team_id', TEAM_ID).get()) {
      for (const r of await CheckResult.where('monitor_id', monitor.id).get())
        await r.delete()
      await monitor.delete()
    }
  }
  beforeAll(cleanup)
  afterEach(async () => {
    responseStatus = 200
    lastSecretHeader = null
    await cleanup()
  })

  const freshTimestamp = () => String(Math.floor(Date.now() / 1000) - 5)

  function body(checks: Array<Record<string, unknown>>, finishedAt: unknown = freshTimestamp()) {
    return JSON.stringify({ finishedAt, checkResults: checks })
  }

  const ok = (name: string) => ({ name, label: name, status: 'ok', notificationMessage: '', shortSummary: 'fine', meta: {} })

  async function runAgainst(payload: string, config: Record<string, unknown> = {}) {
    responseBody = payload
    const monitor = await Monitor.create({
      team_id: TEAM_ID,
      name: 'App health',
      url: `http://localhost:${server.port}/oh-dear-health-check-results`,
      type: 'health',
      status: 'up',
      config: JSON.stringify(config),
    })
    await RunHealthCheck.handle({ monitorId: monitor.id })
    const result = (await CheckResult.where('monitor_id', monitor.id).get())[0]
    return { monitor, result }
  }

  test('all checks ok records an up result', async () => {
    const { result } = await runAgainst(body([ok('DatabaseCheck'), ok('CacheCheck')]))
    expect(result.status).toBe('up')
    expect(result.message).toContain('2 checks passing')
  })

  test('a failed check records down and names it', async () => {
    const { result } = await runAgainst(body([
      ok('DatabaseCheck'),
      { name: 'UsedDiskSpace', label: 'Used Disk Space', status: 'failed', notificationMessage: 'The disk is almost full (91% used)', shortSummary: '91%', meta: { disk_space_used_percentage: 91 } },
    ]))
    expect(result.status).toBe('down')
    expect(result.message).toContain('Used Disk Space')
    expect(result.message).toContain('91%')
  })

  test('a warning check records degraded, not down', async () => {
    const { result } = await runAgainst(body([{ ...ok('UsedDiskSpace'), status: 'warning', notificationMessage: 'Disk at 80%' }]))
    expect(result.status).toBe('degraded')
  })

  test('per-check detail is stored for the UI', async () => {
    const { result } = await runAgainst(body([ok('DatabaseCheck')]))
    const metadata = JSON.parse(result.metadata)
    expect(metadata.appHealth.checks).toHaveLength(1)
    expect(metadata.appHealth.checks[0].name).toBe('DatabaseCheck')
    expect(metadata.appHealth.stale).toBe(false)
    expect(metadata.appHealth.finishedAt).toBeTruthy()
  })

  test('a stale report is down even when every check says ok', async () => {
    // The guard that stops a cached response reporting a dead app as healthy.
    const old = String(Math.floor(Date.now() / 1000) - 3600)
    const { result } = await runAgainst(body([ok('DatabaseCheck')], old))
    expect(result.status).toBe('down')
    expect(result.message).toContain('stale')
    expect(JSON.parse(result.metadata).appHealth.stale).toBe(true)
  })

  test('the staleness window is configurable per monitor', async () => {
    const age = String(Math.floor(Date.now() / 1000) - 120)
    expect((await runAgainst(body([ok('DatabaseCheck')], age), { healthMaxAgeSeconds: 60 })).result.status).toBe('down')
    await cleanup()
    expect((await runAgainst(body([ok('DatabaseCheck')], age), { healthMaxAgeSeconds: 300 })).result.status).toBe('up')
  })

  test('the configured secret is sent in the header that package validates', async () => {
    await runAgainst(body([ok('DatabaseCheck')]), { healthSecret: 's3cret-value' })
    expect(lastSecretHeader).toBe('s3cret-value')
  })

  test('no secret configured sends no header', async () => {
    await runAgainst(body([ok('DatabaseCheck')]))
    expect(lastSecretHeader).toBeNull()
  })

  test('a non-2xx is down regardless of the body', async () => {
    responseStatus = 503
    const { result } = await runAgainst(body([ok('DatabaseCheck')]))
    expect(result.status).toBe('down')
    expect(result.message).toContain('503')
  })

  test('the original { status } contract still works', async () => {
    // Regression guard: adding the new schema must not change existing monitors.
    const { result } = await runAgainst(JSON.stringify({ status: 'ok', checks: { db: true } }))
    expect(result.status).toBe('up')
    expect(result.message).toBe('Healthy')
  })

  /**
   * The loop that matters: the collector we ship to customers, served over a
   * real socket, polled by the real job. If these two ever drift apart the
   * product is broken for everyone who installed the package, and neither
   * side's own unit tests would notice.
   */
  test('the shipped @statushq/agent handler is understood end to end', async () => {
    const handler = createHealthHandler({ checks: [usedMemoryCheck(), usedDiskSpaceCheck()], secret: 'shared' })
    const agentServer = Bun.serve({ port: 0, fetch: handler })
    try {
      const monitor = await Monitor.create({
        team_id: TEAM_ID,
        name: 'Agent-served health',
        url: `http://localhost:${agentServer.port}/health`,
        type: 'health',
        status: 'up',
        config: JSON.stringify({ healthSecret: 'shared' }),
      })
      await RunHealthCheck.handle({ monitorId: monitor.id })

      const result = (await CheckResult.where('monitor_id', monitor.id).get())[0]
      expect(['up', 'degraded', 'down']).toContain(result.status)
      const metadata = JSON.parse(result.metadata)
      expect(metadata.appHealth.checks.map((c: { name: string }) => c.name).sort()).toEqual(['UsedDiskSpace', 'UsedMemory'])
      // Fresh report from a live process: never stale, and timestamped.
      expect(metadata.appHealth.stale).toBe(false)
      expect(metadata.appHealth.finishedAt).toBeTruthy()
    }
    finally {
      agentServer.stop(true)
    }
  })

  test('a wrong secret is rejected by the handler and reads as down', async () => {
    const handler = createHealthHandler({ checks: [usedMemoryCheck()], secret: 'right' })
    const agentServer = Bun.serve({ port: 0, fetch: handler })
    try {
      const monitor = await Monitor.create({
        team_id: TEAM_ID,
        name: 'Bad secret',
        url: `http://localhost:${agentServer.port}/health`,
        type: 'health',
        status: 'up',
        config: JSON.stringify({ healthSecret: 'wrong' }),
      })
      await RunHealthCheck.handle({ monitorId: monitor.id })

      const result = (await CheckResult.where('monitor_id', monitor.id).get())[0]
      expect(result.status).toBe('down')
      expect(result.message).toContain('403')
    }
    finally {
      agentServer.stop(true)
    }
  })
})
