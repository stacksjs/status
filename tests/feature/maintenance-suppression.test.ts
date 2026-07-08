import type { Server } from 'bun'
import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import EvaluateMonitorConsensus from '../../app/Jobs/EvaluateMonitorConsensus'
import RunUptimeCheck from '../../app/Jobs/RunUptimeCheck'
import { isMonitorInMaintenance, maintenanceIntervalsByMonitor, openIncident } from '../../app/lib/maintenance'
import CheckResult from '../../app/Models/CheckResult'
import Incident from '../../app/Models/Incident'
import IncidentUpdate from '../../app/Models/IncidentUpdate'
import MaintenanceWindow from '../../app/Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../app/Models/MaintenanceWindowMonitor'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM_ID = 90013

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
  for (const win of await MaintenanceWindow.where('team_id', TEAM_ID).get()) {
    for (const link of await MaintenanceWindowMonitor.where('maintenance_window_id', win.id).get())
      await link.delete()
    await win.delete()
  }
}

async function makeMonitor(name: string, url = 'https://example.com') {
  return Monitor.create({ team_id: TEAM_ID, name, url, type: 'uptime', check_interval_seconds: 60, enabled: true, status: 'up' })
}

async function coverWithWindow(monitorId: number, startsAt: string, endsAt: string, status = 'active') {
  const win = await MaintenanceWindow.create({ team_id: TEAM_ID, title: 'Planned work', starts_at: startsAt, ends_at: endsAt, status })
  await MaintenanceWindowMonitor.create({ maintenance_window_id: win.id, monitor_id: monitorId })
  return win
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
const HOUR = 3600_000

describe('Maintenance-window suppression (stacksjs/status#1)', () => {
  beforeAll(cleanupTeamFixtures)
  afterEach(cleanupTeamFixtures)

  test('isMonitorInMaintenance: true inside an active window, false when uncovered or out of range', async () => {
    const covered = await makeMonitor('covered')
    const uncovered = await makeMonitor('uncovered')
    await coverWithWindow(covered.id, iso(-HOUR), iso(HOUR))

    expect(await isMonitorInMaintenance(covered.id)).toBe(true)
    expect(await isMonitorInMaintenance(uncovered.id)).toBe(false)
    // An instant before the window opened is not in maintenance.
    expect(await isMonitorInMaintenance(covered.id, Date.now() - 2 * HOUR)).toBe(false)
  })

  test('openIncident suppresses inside a window but creates outside it', async () => {
    const covered = await makeMonitor('covered')
    const free = await makeMonitor('free')
    await coverWithWindow(covered.id, iso(-HOUR), iso(HOUR))

    const suppressed = await openIncident({ monitor_id: covered.id, started_at: iso(0), cause: 'covered fail', status: 'investigating', impacted_checks: '[]' })
    expect(suppressed).toBeNull()
    expect((await Incident.where('monitor_id', covered.id).get()).length).toBe(0)

    const opened = await openIncident({ monitor_id: free.id, started_at: iso(0), cause: 'free fail', status: 'investigating', impacted_checks: '[]' })
    expect(opened).not.toBeNull()
    expect((await Incident.where('monitor_id', free.id).get()).length).toBe(1)
  })

  test('a cancelled window does not suppress (the maintenance did not happen)', async () => {
    const m = await makeMonitor('cancelled-window')
    await coverWithWindow(m.id, iso(-HOUR), iso(HOUR), 'cancelled')

    expect(await isMonitorInMaintenance(m.id)).toBe(false)
    const opened = await openIncident({ monitor_id: m.id, started_at: iso(0), cause: 'still fails', status: 'investigating', impacted_checks: '[]' })
    expect(opened).not.toBeNull()
  })

  test('maintenanceIntervalsByMonitor maps only covered monitors', async () => {
    const a = await makeMonitor('A')
    const b = await makeMonitor('B')
    await coverWithWindow(a.id, iso(-HOUR), iso(HOUR))

    const map = await maintenanceIntervalsByMonitor([a.id, b.id])
    expect(map.has(a.id)).toBe(true)
    expect(map.get(a.id)!.length).toBe(1)
    expect(map.has(b.id)).toBe(false)
  })

  test('consensus skips a covered monitor (no incident, status unchanged) while an uncovered one still goes down', async () => {
    const server: Server = Bun.serve({ port: 0, fetch: () => new Response('err', { status: 500 }) })
    try {
      const covered = await makeMonitor('covered-consensus', `http://localhost:${server.port}/`)
      const uncovered = await makeMonitor('uncovered-consensus', `http://localhost:${server.port}/`)
      await coverWithWindow(covered.id, iso(-HOUR), iso(HOUR))

      await RunUptimeCheck.handle({ monitorId: covered.id })
      await RunUptimeCheck.handle({ monitorId: uncovered.id })
      await EvaluateMonitorConsensus.handle({})

      const coveredAfter = await Monitor.find(covered.id)
      expect(coveredAfter!.status).toBe('up') // never flipped to down
      expect((await Incident.where('monitor_id', covered.id).get()).length).toBe(0)

      const uncoveredAfter = await Monitor.find(uncovered.id)
      expect(uncoveredAfter!.status).toBe('down')
      expect((await Incident.where('monitor_id', uncovered.id).get()).length).toBe(1)
    }
    finally {
      server.stop(true)
    }
  })
})
