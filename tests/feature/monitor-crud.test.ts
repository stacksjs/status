import { afterAll, describe, expect, test } from 'bun:test'
import CreateMonitorAction from '../../app/Actions/Monitors/CreateMonitorAction'
import Monitor from '../../app/Models/Monitor'

// A distinct, high team_id — not shared with other feature test files.
// Bun runs test files concurrently by default; if every file's fixtures
// used team_id 1, CreateMonitorAction's free-tier plan-limit check (5
// monitors) would count monitors created by OTHER files running at the
// same time and 402 unpredictably. Isolating by team_id keeps each
// file's monitor count independent.
const TEAM_ID = 90001

describe('Monitor CRUD (stacksjs/status#1 Phase 1)', () => {
  const createdIds: number[] = []

  afterAll(async () => {
    for (const id of createdIds) {
      const monitor = await Monitor.find(id)
      if (monitor) await monitor.delete()
    }
  })

  test('create persists a monitor with the given fields', async () => {
    // check_interval_seconds must clear the free-tier floor
    // (checkIntervalFloorSeconds: 300 in config/plans.ts) — omitting it
    // defaults to 60s, which is itself a real 402 (a different one than
    // the monitor-count limit this test isn't exercising).
    const request = { get: (key: string) => ({ team_id: String(TEAM_ID), name: 'CRUD test monitor', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300' } as Record<string, string>)[key] }
    const response = await CreateMonitorAction.handle(request as any)
    expect(response.status).toBe(201)

    const body = await response.json() as { id: number, name: string, url: string, type: string }
    createdIds.push(body.id)

    expect(body.name).toBe('CRUD test monitor')
    expect(body.url).toBe('https://example.com')
    expect(body.type).toBe('uptime')
  })

  test('read returns the persisted monitor', async () => {
    const monitor = await Monitor.create({ team_id: TEAM_ID, name: 'Read test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    createdIds.push(monitor.id)

    const found = await Monitor.find(monitor.id)
    expect(found).toBeTruthy()
    expect(found!.name).toBe('Read test')
  })

  test('update persists changed fields', async () => {
    const monitor = await Monitor.create({ team_id: TEAM_ID, name: 'Update test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    createdIds.push(monitor.id)

    await monitor.update({ name: 'Update test (renamed)', check_interval_seconds: 900 })
    const updated = await Monitor.find(monitor.id)

    expect(updated!.name).toBe('Update test (renamed)')
    expect(updated!.check_interval_seconds).toBe(900)
  })

  test('delete removes the monitor', async () => {
    const monitor = await Monitor.create({ team_id: TEAM_ID, name: 'Delete test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    await monitor.delete()

    const found = await Monitor.find(monitor.id)
    expect(found).toBeFalsy()
  })
})
