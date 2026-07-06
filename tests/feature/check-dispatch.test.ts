import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import DispatchDueChecks from '../../app/Jobs/DispatchDueChecks'
import CheckResult from '../../app/Models/CheckResult'
import Incident from '../../app/Models/Incident'
import IncidentUpdate from '../../app/Models/IncidentUpdate'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id since Bun runs test files
// concurrently by default.
const TEAM_ID = 90002

// Deletes every row under this file's TEAM_ID, children before parents
// (incident_updates -> incidents -> check_results -> monitor) so the FK
// constraints on the shared dev SQLite DB are satisfied. Sweeping by team
// instead of tracked ids also clears rows left behind by aborted runs.
async function cleanupTeamFixtures(): Promise<void> {
  for (const monitor of await Monitor.where('team_id', TEAM_ID).get()) {
    for (const incident of await Incident.where('monitor_id', monitor.id).get()) {
      for (const update of await IncidentUpdate.where('incident_id', incident.id).get())
        await update.delete()
      await incident.delete()
    }
    for (const result of await CheckResult.where('monitor_id', monitor.id).get())
      await result.delete()
    await monitor.delete()
  }
}

describe('DispatchDueChecks (stacksjs/status#1 Phase 1)', () => {
  let server: Server

  beforeAll(async () => {
    await cleanupTeamFixtures()
    server = Bun.serve({ port: 0, fetch: () => new Response('OK', { status: 200 }) })
  })

  afterAll(() => {
    server.stop()
  })

  afterEach(async () => {
    await cleanupTeamFixtures()
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

    await DispatchDueChecks.handle({ teamId: TEAM_ID })

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).not.toBe(staleCheckedAt)

    // The check records a region-tagged observation; the monitor's *status*
    // is now derived separately by EvaluateMonitorConsensus (covered by the
    // consensus + incident-lifecycle tests), so this dispatch test asserts the
    // observation was produced, not the derived status.
    const results = await CheckResult.where('monitor_id', monitor.id).get()
    expect(results.length).toBeGreaterThan(0)
    expect(results[results.length - 1]!.status).toBe('up')
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

    await DispatchDueChecks.handle({ teamId: TEAM_ID })

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

    await DispatchDueChecks.handle({ teamId: TEAM_ID })

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).toBe(veryStale)
  })
})
