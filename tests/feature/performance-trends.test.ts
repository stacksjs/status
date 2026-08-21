import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { awaitConfig } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import CheckPerformanceTrends from '../../app/Jobs/CheckPerformanceTrends'
import CheckResult from '../../app/Models/CheckResult'
import Incident from '../../app/Models/Incident'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const SEED = 90071
const TEAM_NAME = `Performance Trends Team ${SEED}`

/**
 * Cover for CheckPerformanceTrends, which had none.
 *
 * The job opened 'Response time degraded' incidents and never closed them —
 * there was no resolve branch in the file at all. It got away with that only
 * because EvaluateMonitorConsensus used to resolve whatever incident happened
 * to be open, including ones it never raised. Restricting that job to its own
 * `impacted_checks[].regions` marker (the fix for the flip-flop that produced
 * 97% of production's incidents) was correct, and left these with no resolver:
 * production accumulated four, two open since 2026-07-06 against monitors that
 * read 'up' the entire time.
 *
 * The open and recover thresholds deliberately differ (2.0x / 1.5x). A single
 * threshold makes a monitor hovering near it flip open/closed on consecutive
 * runs, which is what produced 2,133 sub-two-minute incidents in production,
 * each pair paging every attached channel twice.
 */
describe('Response-time degradation incidents', () => {
  let teamId: number
  let monitorId: number

  /**
   * percentile() takes sorted[floor(0.95 * len)], so with a uniform set the
   * p95 is just that value — these helpers keep the arithmetic obvious.
   */
  const SAMPLES = 6

  async function recordSamples(ms: number, when: 'recent' | 'baseline'): Promise<void> {
    const now = Date.now()
    for (let i = 0; i < SAMPLES; i++) {
      // 'recent' lands inside the last hour; 'baseline' inside the preceding
      // 7 days but comfortably outside that hour.
      const offset = when === 'recent' ? 5 * 60 * 1000 + i * 1000 : 2 * 24 * 60 * 60 * 1000 + i * 1000
      await CheckResult.create({
        monitor_id: monitorId,
        status: 'up',
        responseTimeMs: ms,
        statusCode: 200,
        message: 'ok',
        region: 'default',
        checkedAt: new Date(now - offset).toISOString(),
      })
    }
  }

  async function openDegradationIncidents(): Promise<any[]> {
    return await Incident.where('monitor_id', monitorId)
      .whereLike('cause', 'Response time degraded%')
      .where('status', '!=', 'resolved')
      .get()
  }

  /** Children before parents, depth-first — incident_updates -> incidents, check_results -> monitors. */
  async function purgeTeamMonitors(): Promise<void> {
    for (const monitor of await Monitor.where('team_id', teamId).get()) {
      await db.deleteFrom('check_results').where('monitor_id', '=', monitor.id).execute()
      for (const incident of await Incident.where('monitor_id', monitor.id).get())
        await db.deleteFrom('incident_updates').where('incident_id', '=', incident.id).execute()
      await db.deleteFrom('incidents').where('monitor_id', '=', monitor.id).execute()
      await monitor.delete()
    }
  }

  async function cleanupTeam(): Promise<void> {
    const team = await db.selectFrom('teams').where('name', '=', TEAM_NAME).select(['id']).executeTakeFirst()
    if (team) {
      teamId = Number(team.id)
      await purgeTeamMonitors()
      await db.deleteFrom('teams').where('id', '=', teamId).execute()
    }
  }

  beforeAll(async () => {
    await awaitConfig()
    await cleanupTeam()
    await db.insertInto('teams').values({ name: TEAM_NAME }).execute()
    teamId = Number((await db.selectFrom('teams').where('name', '=', TEAM_NAME).select(['id']).executeTakeFirst())!.id)
  })

  beforeEach(async () => {
    await purgeTeamMonitors()
    const monitor = await Monitor.create({
      team_id: teamId,
      name: `perf-trends-${SEED}`,
      type: 'uptime',
      url: 'https://example.com',
      status: 'up',
    })
    monitorId = Number((monitor as any).id)
  })

  afterAll(cleanupTeam)

  test('opens an incident when the last hour is at least 2x the baseline', async () => {
    await recordSamples(100, 'baseline')
    await recordSamples(1000, 'recent')

    await CheckPerformanceTrends.handle({})

    const open = await openDegradationIncidents()
    expect(open.length).toBe(1)
    expect(open[0].cause).toContain('10.0x')
  })

  test('does not stack a second incident while one is already open', async () => {
    await recordSamples(100, 'baseline')
    await recordSamples(1000, 'recent')

    await CheckPerformanceTrends.handle({})
    await CheckPerformanceTrends.handle({})
    await CheckPerformanceTrends.handle({})

    expect((await openDegradationIncidents()).length).toBe(1)
  })

  test('resolves the incident once response time falls back under 1.5x', async () => {
    await recordSamples(100, 'baseline')
    await recordSamples(1000, 'recent')
    await CheckPerformanceTrends.handle({})
    expect((await openDegradationIncidents()).length).toBe(1)

    // The degradation passes: drop the recent window back to baseline speed.
    await db.deleteFrom('check_results')
      .where('monitor_id', '=', monitorId)
      .where('response_time_ms', '=', 1000)
      .execute()
    await recordSamples(100, 'recent')

    await CheckPerformanceTrends.handle({})

    expect((await openDegradationIncidents()).length).toBe(0)
  })

  test('holds the incident open inside the 1.5x-2x deadband rather than flapping', async () => {
    await recordSamples(100, 'baseline')
    await recordSamples(1000, 'recent')
    await CheckPerformanceTrends.handle({})
    expect((await openDegradationIncidents()).length).toBe(1)

    // 1.7x — recovered past the open threshold but still inside the deadband.
    await db.deleteFrom('check_results')
      .where('monitor_id', '=', monitorId)
      .where('response_time_ms', '=', 1000)
      .execute()
    await recordSamples(170, 'recent')

    await CheckPerformanceTrends.handle({})

    expect((await openDegradationIncidents()).length).toBe(1)
  })

  test('resolves every open duplicate, not just the first', async () => {
    await recordSamples(100, 'baseline')
    await recordSamples(1000, 'recent')
    await CheckPerformanceTrends.handle({})

    // A second incident three milliseconds behind the first is what a race
    // between two runs leaves behind — production carried exactly this pair.
    // Insert it directly: the job's own guard is what normally prevents it.
    const [existing] = await openDegradationIncidents()
    await Incident.create({
      monitor_id: monitorId,
      startedAt: new Date().toISOString(),
      cause: `${existing.cause} `,
      status: 'monitoring',
      impactedChecks: JSON.stringify([{ type: 'performance', recentP95: 1000, baselineP95: 100 }]),
    })
    expect((await openDegradationIncidents()).length).toBe(2)

    await db.deleteFrom('check_results')
      .where('monitor_id', '=', monitorId)
      .where('response_time_ms', '=', 1000)
      .execute()
    await recordSamples(100, 'recent')

    await CheckPerformanceTrends.handle({})

    expect((await openDegradationIncidents()).length).toBe(0)
  })
})
