import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import ReceivePingAction from '../../app/Actions/Heartbeats/ReceivePingAction'
import CheckOverdueHeartbeats from '../../app/Jobs/CheckOverdueHeartbeats'
import HeartbeatMonitor from '../../app/Models/HeartbeatMonitor'
import Incident from '../../app/Models/Incident'
import IncidentUpdate from '../../app/Models/IncidentUpdate'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM_ID = 90017

async function cleanupTeamFixtures(): Promise<void> {
  for (const monitor of await Monitor.where('team_id', TEAM_ID).get()) {
    for (const hb of await HeartbeatMonitor.where('monitor_id', monitor.id).get())
      await hb.delete()
    for (const incident of await Incident.where('monitor_id', monitor.id).get()) {
      for (const update of await IncidentUpdate.where('incident_id', incident.id).get())
        await update.delete()
      await incident.delete()
    }
    await monitor.delete()
  }
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

function fakeRequest(fields: Record<string, string | undefined>) {
  return { get: (key: string) => fields[key] } as any
}

async function makeHeartbeat(name: string, opts: Record<string, unknown> = {}) {
  const monitor = await Monitor.create({ team_id: TEAM_ID, name, url: 'https://example.com', type: 'cron', status: 'up' })
  const heartbeat = await HeartbeatMonitor.create({
    monitor_id: monitor.id,
    ping_token: `tok-${TEAM_ID}-${name}`,
    expected_interval_seconds: 3600,
    grace_seconds: 300,
    ...opts,
  })
  return { monitor, heartbeat }
}

async function openCount(monitorId: number): Promise<number> {
  return (await Incident.where('monitor_id', monitorId).where('status', '!=', 'resolved').get()).length
}

describe('Heartbeat pings: start / fail / recovery (stacksjs/status#1)', () => {
  beforeAll(cleanupTeamFixtures)
  afterEach(cleanupTeamFixtures)

  test('a success ping records last_ping_at and keeps the monitor up', async () => {
    const { monitor, heartbeat } = await makeHeartbeat('ok')
    const res = await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token }))
    expect(res).toMatchObject({ success: true, recorded: 'success' })

    const fresh = await HeartbeatMonitor.find(heartbeat.id)
    expect(fresh!.last_ping_at).toBeTruthy()
    expect((await Monitor.find(monitor.id))!.status).toBe('up')
  })

  test('a start ping stamps last_started_at and does not change status', async () => {
    const { monitor, heartbeat } = await makeHeartbeat('starting')
    const res = await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token, kind: 'start' }))
    expect(res).toMatchObject({ success: true, recorded: 'start' })

    const fresh = await HeartbeatMonitor.find(heartbeat.id)
    expect(fresh!.last_started_at).toBeTruthy()
    expect((await Monitor.find(monitor.id))!.status).toBe('up')
    expect(await openCount(monitor.id)).toBe(0)
  })

  test('a fail ping takes the monitor down and opens an incident', async () => {
    const { monitor, heartbeat } = await makeHeartbeat('failing')
    const res = await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token, kind: 'fail' }))
    expect(res).toMatchObject({ success: true, recorded: 'fail' })

    expect((await Monitor.find(monitor.id))!.status).toBe('down')
    expect(await openCount(monitor.id)).toBe(1)
    const incident = await Incident.where('monitor_id', monitor.id).first()
    expect(incident!.cause).toContain('reported a failure')
  })

  test('a success ping after a fail recovers the monitor and resolves the incident', async () => {
    const { monitor, heartbeat } = await makeHeartbeat('recovers')
    await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token, kind: 'fail' }))
    expect((await Monitor.find(monitor.id))!.status).toBe('down')

    await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token }))
    expect((await Monitor.find(monitor.id))!.status).toBe('up')
    expect(await openCount(monitor.id)).toBe(0)
    const resolved = await Incident.where('monitor_id', monitor.id).first()
    expect(resolved!.status).toBe('resolved')
    expect(resolved!.resolved_at).toBeTruthy()
  })

  test('a success bracketed by a start records the run duration', async () => {
    const { heartbeat } = await makeHeartbeat('timed', { last_started_at: iso(-5000) })
    await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token }))
    const fresh = await HeartbeatMonitor.find(heartbeat.id)
    // ~5s between the seeded start and the success ping.
    expect(fresh!.last_duration_seconds).toBeGreaterThanOrEqual(4)
    expect(fresh!.last_duration_seconds).toBeLessThanOrEqual(7)
  })

  test('an unknown ping kind is rejected (404) and changes nothing', async () => {
    const { monitor, heartbeat } = await makeHeartbeat('bogus')
    const res: any = await ReceivePingAction.handle(fakeRequest({ token: heartbeat.ping_token, kind: 'nonsense' }))
    expect(res.status).toBe(404)
    expect((await Monitor.find(monitor.id))!.status).toBe('up')
    const fresh = await HeartbeatMonitor.find(heartbeat.id)
    expect(fresh!.last_ping_at).toBeFalsy()
  })

  test('an unknown token is a 404', async () => {
    const res: any = await ReceivePingAction.handle(fakeRequest({ token: 'not-a-real-token' }))
    expect(res.status).toBe(404)
  })

  test('CheckOverdueHeartbeats opens an overrun incident for a start with no success in grace', async () => {
    // Started ~10 min ago with a tiny grace; last success is even older.
    const { monitor } = await makeHeartbeat('overran', {
      grace_seconds: 60,
      last_ping_at: iso(-30 * 60_000),
      last_started_at: iso(-10 * 60_000),
    })
    await CheckOverdueHeartbeats.handle()

    expect((await Monitor.find(monitor.id))!.status).toBe('down')
    const incident = await Incident.where('monitor_id', monitor.id).first()
    expect(incident!.cause).toContain('grace window')
  })

  test('CheckOverdueHeartbeats uses the cron expression for the deadline, not the interval', async () => {
    // Interval is huge, so only the every-minute cron cadence can make this
    // overdue: last ping 10 min ago, tiny grace.
    const { monitor } = await makeHeartbeat('cronned', {
      expected_interval_seconds: 999_999,
      grace_seconds: 60,
      cron_expression: '* * * * *',
      last_ping_at: iso(-10 * 60_000),
    })
    await CheckOverdueHeartbeats.handle()

    expect((await Monitor.find(monitor.id))!.status).toBe('down')
    const incident = await Incident.where('monitor_id', monitor.id).first()
    expect(incident!.cause).toContain('missed its expected check-in')
  })

  test('a valid cron heartbeat pinged within the slot stays up despite a huge interval', async () => {
    const { monitor } = await makeHeartbeat('cron-healthy', {
      expected_interval_seconds: 999_999,
      grace_seconds: 60,
      cron_expression: '* * * * *',
      last_ping_at: iso(-10_000), // 10s ago; next minute slot has not lapsed + grace
    })
    await CheckOverdueHeartbeats.handle()
    expect((await Monitor.find(monitor.id))!.status).toBe('up')
  })

  test('CheckOverdueHeartbeats opens a missed incident when the cadence lapses', async () => {
    const { monitor } = await makeHeartbeat('missed', {
      expected_interval_seconds: 300,
      grace_seconds: 60,
      last_ping_at: iso(-30 * 60_000),
    })
    await CheckOverdueHeartbeats.handle()

    expect((await Monitor.find(monitor.id))!.status).toBe('down')
    const incident = await Incident.where('monitor_id', monitor.id).first()
    expect(incident!.cause).toContain('missed its expected check-in')
  })
})
