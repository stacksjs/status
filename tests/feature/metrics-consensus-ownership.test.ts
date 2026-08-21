import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { awaitConfig } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { CONSENSUS_TYPES } from '../../config/regions'
import { openIncident } from '../../app/lib/maintenance'
import EvaluateMonitorConsensus from '../../app/Jobs/EvaluateMonitorConsensus'
import CheckResult from '../../app/Models/CheckResult'
import Incident from '../../app/Models/Incident'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const SEED = 90042
const TEAM_NAME = `Metrics Ownership Team ${SEED}`

/**
 * Regression cover for the incident flip-flop between CheckStaleMetrics and
 * EvaluateMonitorConsensus.
 *
 * `reports_metrics` is orthogonal to `type`, so an 'uptime' monitor can be
 * both consensus-managed and metrics-reporting. CheckStaleMetrics used to
 * write `status: 'down'` for a silent agent and EvaluateMonitorConsensus wrote
 * `status: 'up'` because the polls were passing — then resolved whatever
 * incident happened to be open, including the metrics one it never opened.
 * Each job undid the other every minute: production logged 93,864 of its
 * 96,350 incidents (97%) from that single loop, and every open/resolve pair
 * paged each attached channel.
 *
 * The contract now: consensus resolves only incidents carrying its own
 * `impacted_checks[].regions` marker, and a metrics incident dedups on its
 * cause so it cannot stack.
 */
describe('Metrics vs consensus incident ownership', () => {
  let teamId: number
  let monitorId: number

  const METRICS_IMPACT = JSON.stringify([{ type: 'server_metrics', reason: 'missed_push', windowSeconds: 300 }])
  const CONSENSUS_IMPACT = JSON.stringify([{ type: 'uptime', regions: ['us-east', 'eu-central'] }])

  /** The ownership predicate EvaluateMonitorConsensus applies before resolving. */
  function consensusOwns(incident: { impacted_checks?: string | null }): boolean {
    try {
      const impacted = JSON.parse(incident.impacted_checks || '[]')
      return Array.isArray(impacted) && impacted.some((entry: any) => Array.isArray(entry?.regions))
    }
    catch {
      return false
    }
  }

  /**
   * Children before parents, depth-first: incident_updates -> incidents and
   * check_results -> monitors are both real FKs, and resolving an incident
   * writes an IncidentUpdate, so any test that drives the job leaves
   * grandchildren behind. One helper for both teardowns — when these were
   * written out twice they drifted, and the copy that was missing a level
   * failed only when the suite ran in order.
   */
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
      name: `metrics-owner-${SEED}`,
      type: 'uptime',
      url: 'https://example.com',
      status: 'up',
    })
    monitorId = Number((monitor as any).id)
  })

  afterAll(cleanupTeam)

  test("'uptime' is consensus-managed, so its status is not CheckStaleMetrics' to write", () => {
    expect(CONSENSUS_TYPES).toContain('uptime')
  })

  test('consensus does not claim a metrics incident', async () => {
    await openIncident({
      monitor_id: monitorId,
      started_at: new Date().toISOString(),
      cause: `No metrics received from 'metrics-owner' agent within 300s`,
      status: 'investigating',
      impacted_checks: METRICS_IMPACT,
    })

    const open = await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()
    expect(open.length).toBe(1)
    expect(open.filter(consensusOwns).length).toBe(0)
  })

  test('consensus does claim the incident it opened itself', async () => {
    await openIncident({
      monitor_id: monitorId,
      started_at: new Date().toISOString(),
      cause: 'down from 2/2 region(s): us-east, eu-central',
      status: 'investigating',
      impacted_checks: CONSENSUS_IMPACT,
    })

    const open = await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()
    expect(open.filter(consensusOwns).length).toBe(1)
  })

  test('a recovery resolves only the consensus incident, leaving the metrics one open', async () => {
    await openIncident({
      monitor_id: monitorId,
      started_at: new Date().toISOString(),
      cause: `No metrics received from 'metrics-owner' agent within 300s`,
      status: 'investigating',
      impacted_checks: METRICS_IMPACT,
    })
    await openIncident({
      monitor_id: monitorId,
      started_at: new Date().toISOString(),
      cause: 'down from 2/2 region(s): us-east, eu-central',
      status: 'investigating',
      impacted_checks: CONSENSUS_IMPACT,
    })

    // What the recovery branch does: pick its own incident and resolve that one.
    const candidates = await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').orderByDesc('created_at').get()
    const owned = candidates.find(consensusOwns)
    expect(owned).toBeDefined()
    await (owned as any).update({ status: 'resolved', resolved_at: new Date().toISOString() })

    const stillOpen = await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()
    expect(stillOpen.length).toBe(1)
    expect(stillOpen[0].cause).toContain('No metrics received')
  })

  test('a metrics incident cannot stack while it is still open', async () => {
    const cause = `No metrics received from 'metrics-owner' agent within 300s`
    const attrs = { monitor_id: monitorId, cause, status: 'investigating', impacted_checks: METRICS_IMPACT }

    // Three consecutive minutes of the job ticking against a silent agent.
    await openIncident({ ...attrs, started_at: new Date().toISOString() })
    await openIncident({ ...attrs, started_at: new Date().toISOString() })
    await openIncident({ ...attrs, started_at: new Date().toISOString() })

    expect((await Incident.where('monitor_id', monitorId).get()).length).toBe(1)
  })

  /**
   * Recovery must be reconciled from state, not from the down->up edge.
   *
   * `monitor.status` has more than one writer: ReceiveMetricsAction writes it
   * straight from the agent's fleet aggregation. So by the time
   * EvaluateMonitorConsensus runs, the monitor can already read 'up' and the
   * edge is gone — `next === prev` short-circuits, and an incident this job
   * opened stays open forever. Production #96382 sat open for hours against a
   * monitor reading 'up' with six passing checks behind it.
   *
   * These two drive the real job rather than a copy of its predicate, so they
   * fail against the edge-triggered version.
   */
  describe('recovery reconciles from state, not the transition edge', () => {
    /** A fresh passing vote, so consensus computes next === 'up'. */
    async function recordPassingCheck(): Promise<void> {
      await CheckResult.create({
        monitor_id: monitorId,
        status: 'up',
        responseTimeMs: 12,
        statusCode: 200,
        message: 'ok',
        region: 'default',
        checkedAt: new Date().toISOString(),
      })
    }

    test('resolves an incident whose recovery edge was already spent by another writer', async () => {
      // The monitor already reads 'up' (beforeEach) — exactly the state left
      // behind when ReceiveMetricsAction wrote the recovery first.
      await openIncident({
        monitor_id: monitorId,
        started_at: new Date().toISOString(),
        cause: 'Unexpected status code 504 — down from 1/1 region(s): eu-central',
        status: 'investigating',
        impacted_checks: CONSENSUS_IMPACT,
      })
      await recordPassingCheck()

      expect((await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()).length).toBe(1)

      await EvaluateMonitorConsensus.handle({})

      const stillOpen = await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()
      expect(stillOpen.length).toBe(0)
    })

    test('still leaves a metrics incident alone — reconciling is not a licence to close what it does not own', async () => {
      await openIncident({
        monitor_id: monitorId,
        started_at: new Date().toISOString(),
        cause: `No metrics received from 'metrics-owner' agent within 300s`,
        status: 'investigating',
        impacted_checks: METRICS_IMPACT,
      })
      await recordPassingCheck()

      await EvaluateMonitorConsensus.handle({})

      const stillOpen = await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()
      expect(stillOpen.length).toBe(1)
      expect(stillOpen[0].cause).toContain('No metrics received')
    })
  })
})
