import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import UpdateMaintenanceWindowStatus from '../../app/Jobs/UpdateMaintenanceWindowStatus'
import { isMonitorInMaintenance, maintenanceIntervalsByMonitor } from '../../app/lib/maintenance'
import MaintenanceWindow from '../../app/Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../app/Models/MaintenanceWindowMonitor'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM_ID = 90018

async function cleanupTeamFixtures(): Promise<void> {
  for (const win of await MaintenanceWindow.where('team_id', TEAM_ID).get()) {
    for (const link of await MaintenanceWindowMonitor.where('maintenance_window_id', win.id).get())
      await link.delete()
    await win.delete()
  }
  for (const monitor of await Monitor.where('team_id', TEAM_ID).get())
    await monitor.delete()
}

async function makeMonitor(name: string) {
  return Monitor.create({ team_id: TEAM_ID, name, url: 'https://example.com', type: 'uptime', check_interval_seconds: 60, enabled: true, status: 'up' })
}

async function makeWindow(opts: Record<string, unknown>) {
  return MaintenanceWindow.create({
    team_id: TEAM_ID,
    title: 'Recurring work',
    starts_at: '2026-07-05T02:00:00.000Z',
    ends_at: '2026-07-05T02:30:00.000Z',
    status: 'active',
    ...opts,
  })
}

async function cover(monitorId: number, windowId: number) {
  await MaintenanceWindowMonitor.create({ maintenance_window_id: windowId, monitor_id: monitorId })
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
const MIN = 60_000

describe('Recurring maintenance windows (stacksjs/status#1)', () => {
  beforeAll(cleanupTeamFixtures)
  afterEach(cleanupTeamFixtures)

  test('a monitor is in maintenance during any weekly occurrence, not between them', async () => {
    const monitor = await makeMonitor('weekly')
    const win = await makeWindow({ recurrence_cron: '0 2 * * 0' }) // Sundays 02:00 UTC, 30 min
    await cover(monitor.id, win.id)

    // A later Sunday, 15 minutes into the window.
    expect(await isMonitorInMaintenance(monitor.id, Date.parse('2026-07-12T02:15:00Z'))).toBe(true)
    // Same Sunday, midday — outside the window.
    expect(await isMonitorInMaintenance(monitor.id, Date.parse('2026-07-12T12:00:00Z'))).toBe(false)
    // A weekday is never covered.
    expect(await isMonitorInMaintenance(monitor.id, Date.parse('2026-07-15T02:15:00Z'))).toBe(false)
  })

  test('maintenanceIntervalsByMonitor expands a recurrence across the range', async () => {
    const monitor = await makeMonitor('weekly-range')
    const win = await makeWindow({ recurrence_cron: '0 2 * * 0' })
    await cover(monitor.id, win.id)

    const map = await maintenanceIntervalsByMonitor([monitor.id], {
      fromMs: Date.parse('2026-07-05T00:00:00Z'),
      toMs: Date.parse('2026-07-26T12:00:00Z'),
    })
    expect(map.get(monitor.id)!.length).toBe(4) // Jul 5, 12, 19, 26
  })

  test('a cancelled recurring window never suppresses', async () => {
    const monitor = await makeMonitor('cancelled-recurring')
    const win = await makeWindow({ recurrence_cron: '0 2 * * 0', status: 'cancelled' })
    await cover(monitor.id, win.id)
    expect(await isMonitorInMaintenance(monitor.id, Date.parse('2026-07-12T02:15:00Z'))).toBe(false)
  })

  test('UpdateMaintenanceWindowStatus marks a recurring window active while an occurrence is live', async () => {
    // Fires every minute with a 5-minute duration, so "now" is always inside an
    // occurrence regardless of when the test runs.
    const win = await makeWindow({ recurrence_cron: '* * * * *', starts_at: iso(-MIN), ends_at: iso(4 * MIN), status: 'scheduled' })
    await UpdateMaintenanceWindowStatus.handle()
    expect((await MaintenanceWindow.find(win.id))!.status).toBe('active')
  })

  test('UpdateMaintenanceWindowStatus reverts a recurring window to scheduled between occurrences (never completed)', async () => {
    // Fires yearly on Jan 1; "now" (unless the test runs at that instant) is
    // outside every occurrence, so an active window should revert to scheduled.
    const win = await makeWindow({ recurrence_cron: '0 2 1 1 *', starts_at: '2026-01-01T02:00:00Z', ends_at: '2026-01-01T02:30:00Z', status: 'active' })
    await UpdateMaintenanceWindowStatus.handle()
    const after = (await MaintenanceWindow.find(win.id))!.status
    expect(after).toBe('scheduled')
    expect(after).not.toBe('completed')
  })

  test('a one-off window still completes once its end passes', async () => {
    const win = await makeWindow({ starts_at: iso(-2 * MIN), ends_at: iso(-MIN), status: 'active' }) // no recurrence_cron
    await UpdateMaintenanceWindowStatus.handle()
    expect((await MaintenanceWindow.find(win.id))!.status).toBe('completed')
  })
})
