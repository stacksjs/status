import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import RunHealthCheck from '../../app/Jobs/RunHealthCheck'
import Assertion from '../../app/Models/Assertion'
import CheckResult from '../../app/Models/CheckResult'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM_ID = 90015

describe('Health-check field assertions (stacksjs/status#1)', () => {
  let server: Server
  let responseBody = ''

  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => new Response(responseBody, { status: 200, headers: { 'content-type': 'application/json' } }) })
  })
  afterAll(() => server.stop(true))

  async function cleanup(): Promise<void> {
    for (const monitor of await Monitor.where('team_id', TEAM_ID).get()) {
      for (const a of await Assertion.where('monitor_id', monitor.id).get())
        await a.delete()
      for (const r of await CheckResult.where('monitor_id', monitor.id).get())
        await r.delete()
      await monitor.delete()
    }
  }
  beforeAll(cleanup)
  afterEach(cleanup)

  async function healthMonitor() {
    return Monitor.create({ team_id: TEAM_ID, name: 'Health', url: `http://localhost:${server.port}/`, type: 'health', status: 'up' })
  }

  async function addAssertion(monitorId: number, property: string, compare: string, expected: string) {
    await Assertion.create({ monitor_id: monitorId, target: 'body', property, compare, expected, sort_order: 0 })
  }

  async function latestStatus(monitorId: number): Promise<{ status: string, message: string }> {
    const results = await CheckResult.where('monitor_id', monitorId).orderByDesc('created_at').get()
    return { status: results[0]!.status, message: results[0]!.message }
  }

  test('passing dot-path assertions record an up result', async () => {
    responseBody = JSON.stringify({ status: 'ok', checks: { database: { latency_ms: 12 }, queue: { pending: 10 } } })
    const monitor = await healthMonitor()
    await addAssertion(monitor.id, 'checks.database.latency_ms', 'lt', '100')
    await addAssertion(monitor.id, 'checks.queue.pending', 'lt', '5000')

    await RunHealthCheck.handle({ monitorId: monitor.id })

    expect((await latestStatus(monitor.id)).status).toBe('up')
  })

  test('a failing dot-path assertion records a down result naming the field', async () => {
    responseBody = JSON.stringify({ status: 'ok', checks: { queue: { pending: 8421 } } })
    const monitor = await healthMonitor()
    await addAssertion(monitor.id, 'checks.queue.pending', 'lt', '5000')

    await RunHealthCheck.handle({ monitorId: monitor.id })

    const result = await latestStatus(monitor.id)
    expect(result.status).toBe('down')
    expect(result.message).toContain('checks.queue.pending')
  })

  test('a missing asserted path records down (the health shape changed)', async () => {
    responseBody = JSON.stringify({ status: 'ok', checks: {} })
    const monitor = await healthMonitor()
    await addAssertion(monitor.id, 'checks.database.status', 'eq', 'ok')

    await RunHealthCheck.handle({ monitorId: monitor.id })

    expect((await latestStatus(monitor.id)).status).toBe('down')
  })

  test('assertions are authoritative even with no top-level status field', async () => {
    responseBody = JSON.stringify({ checks: { database: { latency_ms: 5 } } })
    const monitor = await healthMonitor()
    await addAssertion(monitor.id, 'checks.database.latency_ms', 'lt', '100')

    await RunHealthCheck.handle({ monitorId: monitor.id })

    // Legacy behavior would mark this down for "no status field"; with an
    // assertion configured, the assertion defines healthy.
    expect((await latestStatus(monitor.id)).status).toBe('up')
  })

  test('a monitor with no assertions keeps the legacy top-level status contract', async () => {
    responseBody = JSON.stringify({ status: 'degraded' })
    const monitor = await healthMonitor()

    await RunHealthCheck.handle({ monitorId: monitor.id })

    expect((await latestStatus(monitor.id)).status).toBe('degraded')
  })
})
