import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import DispatchDueChecks from '../../app/Jobs/DispatchDueChecks'
import CheckResult from '../../app/Models/CheckResult'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id since Bun runs test files
// concurrently by default.
const TEAM_ID = 90002

describe('DispatchDueChecks (stacksjs/status#1 Phase 1)', () => {
  let server: Server
  const createdIds: number[] = []

  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => new Response('OK', { status: 200 }) })
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    for (const id of createdIds.splice(0)) {
      const monitor = await Monitor.find(id)
      if (monitor) await monitor.delete()
    }
  })

  test('a monitor whose check_interval_seconds has elapsed gets checked (QUEUE_DRIVER=sync runs the job inline)', async () => {
    const staleCheckedAt = new Date(Date.now() - 120_000).toISOString()
    const monitor = await Monitor.create({
      team_id: TEAM_ID,
      name: 'Dispatch-due test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      check_interval_seconds: 60,
      last_checked_at: staleCheckedAt,
      enabled: true,
    })
    createdIds.push(monitor.id)

    await DispatchDueChecks.handle()

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).not.toBe(staleCheckedAt)
    expect(refreshed!.status).toBe('up')

    const results = await CheckResult.where('monitor_id', monitor.id).get()
    expect(results.length).toBeGreaterThan(0)
  })

  test('a monitor not yet due for a check is skipped', async () => {
    const recentCheckedAt = new Date().toISOString()
    const monitor = await Monitor.create({
      team_id: TEAM_ID,
      name: 'Dispatch-not-due test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      check_interval_seconds: 3600,
      last_checked_at: recentCheckedAt,
      enabled: true,
    })
    createdIds.push(monitor.id)

    await DispatchDueChecks.handle()

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).toBe(recentCheckedAt)
  })

  test('a disabled monitor is never dispatched regardless of how overdue it is', async () => {
    const veryStale = new Date(Date.now() - 86_400_000).toISOString()
    const monitor = await Monitor.create({
      team_id: TEAM_ID,
      name: 'Dispatch-disabled test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      check_interval_seconds: 60,
      last_checked_at: veryStale,
      enabled: false,
    })
    createdIds.push(monitor.id)

    await DispatchDueChecks.handle()

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).toBe(veryStale)
  })
})
