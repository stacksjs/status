import type { Server } from 'bun'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import EvaluateMonitorConsensus from '../../app/Jobs/EvaluateMonitorConsensus'
import RunUptimeCheck from '../../app/Jobs/RunUptimeCheck'
import CheckResult from '../../app/Models/CheckResult'
import Incident from '../../app/Models/Incident'
import IncidentUpdate from '../../app/Models/IncidentUpdate'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id since Bun runs test files
// concurrently by default.
const TEAM_ID = 90003

// Status transitions + incident open/resolve moved from the check jobs into
// EvaluateMonitorConsensus (stacksjs/status#1 Phase 11): a check now only
// records a region-tagged CheckResult, and the consensus pass turns those
// observations into the monitor's status. With one region the threshold
// clamps to 1, so a single failing check still transitions to down — this
// suite drives the check then the consensus pass and asserts that end state.
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

describe('Incident open/resolve lifecycle (stacksjs/status#1 Phase 1)', () => {
  let server: Server
  let shouldFail = false

  beforeAll(async () => {
    await cleanupTeamFixtures()
  })

  afterAll(() => {
    server?.stop()
  })

  afterEach(async () => {
    await cleanupTeamFixtures()
    shouldFail = false
  })

  test('a failing check opens an incident', async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response('Internal Server Error', { status: 500 }),
    })

    const monitor = await Monitor.create({
      team_id: TEAM_ID,
      name: 'Incident-open test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      check_interval_seconds: 60,
      enabled: true,
      status: 'up', // starts healthy so the failing check is a real transition
    })

    await RunUptimeCheck.handle({ monitorId: monitor.id })
    await EvaluateMonitorConsensus.handle({})

    const refreshed = await Monitor.find(monitor.id)
    expect(refreshed!.status).toBe('down')

    const incidents = await Incident.where('monitor_id', monitor.id).get()
    expect(incidents.length).toBe(1)
    expect(incidents[0]!.status).toBe('investigating')
    expect(incidents[0]!.resolved_at).toBeFalsy()

    server.stop()
  })

  test('a recovering check resolves the open incident', async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(shouldFail ? 'Internal Server Error' : 'OK', { status: shouldFail ? 500 : 200 }),
    })

    const monitor = await Monitor.create({
      team_id: TEAM_ID,
      name: 'Incident-resolve test',
      url: `http://localhost:${server.port}/`,
      type: 'uptime',
      check_interval_seconds: 60,
      enabled: true,
      status: 'up',
    })

    // First check fails -> consensus opens an incident.
    shouldFail = true
    await RunUptimeCheck.handle({ monitorId: monitor.id })
    await EvaluateMonitorConsensus.handle({})
    const afterFailure = await Monitor.find(monitor.id)
    expect(afterFailure!.status).toBe('down')

    const openIncidents = await Incident.where('monitor_id', monitor.id).get()
    expect(openIncidents.length).toBe(1)
    const incidentId = openIncidents[0]!.id

    // Second check succeeds -> consensus resolves the same incident.
    shouldFail = false
    await RunUptimeCheck.handle({ monitorId: monitor.id })
    await EvaluateMonitorConsensus.handle({})
    const afterRecovery = await Monitor.find(monitor.id)
    expect(afterRecovery!.status).toBe('up')

    const resolvedIncident = await Incident.find(incidentId)
    expect(resolvedIncident!.status).toBe('resolved')
    expect(resolvedIncident!.resolved_at).toBeTruthy()

    const updates = await IncidentUpdate.where('incident_id', incidentId).get()
    expect(updates.some(u => u.status === 'resolved')).toBe(true)

    server.stop()
  })
})
