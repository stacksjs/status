import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { featureTest } from '@stacksjs/testing'
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
      teamId: TEAM_ID,
      name: 'Dispatch-due test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      checkIntervalSeconds: 60,
      lastCheckedAt: staleCheckedAt,
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
      teamId: TEAM_ID,
      name: 'Dispatch-not-due test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      checkIntervalSeconds: 3600,
      lastCheckedAt: recentCheckedAt,
      enabled: true,
    })

    await DispatchDueChecks.handle({ teamId: TEAM_ID })

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).toBe(recentCheckedAt)
  })

  test('a disabled monitor is never dispatched regardless of how overdue it is', async () => {
    const veryStale = new Date(Date.now() - 86_400_000).toISOString()
    const monitor = await Monitor.create({
      teamId: TEAM_ID,
      name: 'Dispatch-disabled test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      checkIntervalSeconds: 60,
      lastCheckedAt: veryStale,
      enabled: false,
    })

    await DispatchDueChecks.handle({ teamId: TEAM_ID })

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.last_checked_at).toBe(veryStale)
  })

  /**
   * `last_checked_at` is this job's scheduling clock — `dueAt` is derived from
   * it — so anything else writing it moves the next probe further away.
   * ReceiveMetricsAction used to write it on every agent push, and an agent
   * pushing faster than the monitor's own interval therefore held dueAt
   * permanently in the future: production monitor 49 went unprobed from
   * 2026-08-21T08:44 (agent every ~30s against a 60s interval) while monitor
   * 48 survived only because its agent happened to push a little slower than
   * its interval. Losing the probe also starved CheckPerformanceTrends of
   * response times, stranding two degradation incidents with nothing to
   * recover on.
   */
  describe('an agent metrics push must not starve the monitor\'s own probe', () => {
    test('a polled monitor is still dispatched after an agent push', async () => {
      const token = `mtok-dispatch-${TEAM_ID}-${Math.floor(performance.now() * 1000)}`
      const monitor = await Monitor.create({
        teamId: TEAM_ID,
        name: 'Dispatch agent-fed test',
        url: `http://localhost:${server.port}/`,
        type: 'uptime',
        checkIntervalSeconds: 60,
        lastCheckedAt: new Date(Date.now() - 120_000).toISOString(),
        enabled: true,
        reportsMetrics: true,
        metricsToken: token,
      })

      // The agent reports in, exactly as it would seconds before the probe is due.
      const pushed = await featureTest().post(`/api/agent/${token}/metrics`, {
        cpuPercent: 5,
        ramPercent: 5,
        ramUsedMb: 1,
        ramTotalMb: 2,
      })
      expect(pushed.status).toBe(200)

      await DispatchDueChecks.handle({ teamId: TEAM_ID })

      // The probe's own observation, not the agent's sample.
      const probed = (await CheckResult.where('monitor_id', monitor.id).get()).filter(r => r.region !== 'agent')
      expect(probed.length).toBeGreaterThan(0)
    })

    test('a monitor nothing else probes still takes its clock from the agent push', async () => {
      const token = `mtok-passive-${TEAM_ID}-${Math.floor(performance.now() * 1000)}`
      const stale = new Date(Date.now() - 120_000).toISOString()
      // 'cron' is heartbeat-based, so DispatchDueChecks never dispatches it and
      // no probe will ever set this column — the agent is the only writer left.
      const monitor = await Monitor.create({
        teamId: TEAM_ID,
        name: 'Dispatch passive test',
        url: `http://localhost:${server.port}/`,
        type: 'cron',
        checkIntervalSeconds: 60,
        lastCheckedAt: stale,
        enabled: true,
        reportsMetrics: true,
        metricsToken: token,
      })

      await featureTest().post(`/api/agent/${token}/metrics`, {
        cpuPercent: 5,
        ramPercent: 5,
        ramUsedMb: 1,
        ramTotalMb: 2,
      })

      const refreshed = await Monitor.find(monitor.id)
      expect(refreshed!.last_checked_at).not.toBe(stale)
    })
  })
})
