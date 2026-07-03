import type { Server } from 'bun'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import RunUptimeCheck from '../../app/Jobs/RunUptimeCheck'
import Incident from '../../app/Models/Incident'
import IncidentUpdate from '../../app/Models/IncidentUpdate'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id since Bun runs test files
// concurrently by default.
const TEAM_ID = 90003

describe('Incident open/resolve lifecycle (stacksjs/status#1 Phase 1)', () => {
  let server: Server
  let shouldFail = false
  const createdMonitorIds: number[] = []

  afterAll(() => {
    server?.stop()
  })

  afterEach(async () => {
    for (const id of createdMonitorIds.splice(0)) {
      const monitor = await Monitor.find(id)
      if (monitor) {
        for (const incident of await Incident.where('monitor_id', id).get())
          await incident.delete()
        await monitor.delete()
      }
    }
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
      status: 'up', // starts healthy so the failing check is a real transition
    })
    createdMonitorIds.push(monitor.id)

    await RunUptimeCheck.handle({ monitorId: monitor.id })

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
      status: 'up',
    })
    createdMonitorIds.push(monitor.id)

    // First check fails -> opens an incident.
    shouldFail = true
    await RunUptimeCheck.handle({ monitorId: monitor.id })
    const afterFailure = await Monitor.find(monitor.id)
    expect(afterFailure!.status).toBe('down')

    const openIncidents = await Incident.where('monitor_id', monitor.id).get()
    expect(openIncidents.length).toBe(1)
    const incidentId = openIncidents[0]!.id

    // Second check succeeds -> resolves the same incident.
    shouldFail = false
    await RunUptimeCheck.handle({ monitorId: monitor.id })
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
