import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { awaitConfig, config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture'
import DashboardSaveRoutingAction from '../../app/Actions/Notifications/DashboardSaveRoutingAction'
import SendIncidentNotification from '../../app/Actions/Notifications/SendIncidentNotification'
import Monitor from '../../app/Models/Monitor'
import MonitorNotificationChannel from '../../app/Models/MonitorNotificationChannel'
import NotificationChannel from '../../app/Models/NotificationChannel'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const SEED = 90014
const OWNER_EMAIL = `notif-severity-owner-${SEED}@example.com`

describe('Per-severity notification routing (stacksjs/status#1)', () => {
  let teamId: number
  let userId: number
  let token: string

  function fakeRequest(fields: Record<string, string | undefined>, tok?: string) {
    return { get: (key: string) => fields[key], bearerToken: () => tok, cookies: { get: () => undefined } } as any
  }

  // Delete this seed's monitors/channels but keep the team/user (reused across
  // this file's tests).
  async function cleanupFixtures(): Promise<void> {
    for (const monitor of await Monitor.where('team_id', teamId).get()) {
      for (const link of await MonitorNotificationChannel.where('monitor_id', monitor.id).get())
        await link.delete()
      await monitor.delete()
    }
    for (const channel of await NotificationChannel.where('team_id', teamId).get())
      await channel.delete()
  }

  // Full teardown incl. the team/user, by name/email so it also clears rows a
  // prior aborted run left behind (teams.name is unique).
  async function cleanupTeam(): Promise<void> {
    const team = await db.selectFrom('teams').where('name', '=', `Notif Severity Team ${SEED}`).select(['id']).executeTakeFirst()
    if (team) {
      teamId = Number(team.id)
      await cleanupFixtures()
      await db.deleteFrom('team_members').where('team_id', '=', teamId).execute()
      await db.deleteFrom('teams').where('id', '=', teamId).execute()
    }
    await db.deleteFrom('users').where('email', '=', OWNER_EMAIL).execute()
  }

  beforeAll(async () => {
    await awaitConfig()
    ;(config.email as { default: string }).default = 'capture'

    await cleanupTeam()
    await db.insertInto('teams').values({ name: `Notif Severity Team ${SEED}` }).execute()
    teamId = Number((await db.selectFrom('teams').where('name', '=', `Notif Severity Team ${SEED}`).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('users').values({ name: 'Notif Owner', email: OWNER_EMAIL, password: 'x'.repeat(10) }).execute()
    userId = Number((await db.selectFrom('users').where('email', '=', OWNER_EMAIL).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('team_members').values({ team_id: teamId, user_id: userId, role: 'owner', status: 'active', invited_email: OWNER_EMAIL }).execute()
    token = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)
  })

  afterEach(async () => {
    CaptureEmailDriver.clear()
    await cleanupFixtures()
  })

  afterAll(cleanupTeam)

  async function emailChannel(name: string, address: string) {
    return NotificationChannel.create({ teamId: teamId, name, type: 'email', config: JSON.stringify({ email: address }), enabled: true })
  }

  async function attach(monitorId: number, channelId: number, firesOn: string) {
    await MonitorNotificationChannel.create({ monitor_id: monitorId, notification_channel_id: channelId, firesOn: firesOn })
  }

  async function recipients(): Promise<string[]> {
    return CaptureEmailDriver.all().map((m: any) => String(m.to))
  }

  test('a down incident notifies down-only and both channels, not issue-only', async () => {
    const monitor = await Monitor.create({ teamId: teamId, name: 'API', url: 'https://api.example.com', type: 'uptime', status: 'up' })
    await attach(monitor.id, (await emailChannel('down', 'down@example.com')).id, 'down')
    await attach(monitor.id, (await emailChannel('issue', 'issue@example.com')).id, 'issue')
    await attach(monitor.id, (await emailChannel('both', 'both@example.com')).id, 'both')

    await SendIncidentNotification.handle({ id: 1, monitor_id: monitor.id, cause: 'down', status: 'investigating', started_at: new Date().toISOString() })

    const to = await recipients()
    expect(to).toContain('down@example.com')
    expect(to).toContain('both@example.com')
    expect(to).not.toContain('issue@example.com')
  })

  test('an issue incident notifies issue-only and both channels, not down-only', async () => {
    // A 'dns' monitor's incident is a soft issue (see ISSUE_MONITOR_TYPES).
    const monitor = await Monitor.create({ teamId: teamId, name: 'DNS', url: 'https://example.com', type: 'dns', status: 'up' })
    await attach(monitor.id, (await emailChannel('down', 'down@example.com')).id, 'down')
    await attach(monitor.id, (await emailChannel('issue', 'issue@example.com')).id, 'issue')
    await attach(monitor.id, (await emailChannel('both', 'both@example.com')).id, 'both')

    await SendIncidentNotification.handle({ id: 2, monitor_id: monitor.id, cause: 'drift', status: 'investigating', started_at: new Date().toISOString() })

    const to = await recipients()
    expect(to).toContain('issue@example.com')
    expect(to).toContain('both@example.com')
    expect(to).not.toContain('down@example.com')
  })

  test('a host resource breach is an issue, not an outage', async () => {
    // A metrics-reporting monitor has two failure modes and its TYPE cannot
    // tell them apart: a CPU/RAM/disk threshold breach (the agent pushed, the box is
    // busy) and the agent going silent (the box may be gone). Severity now
    // comes from the incident's own impacted_checks, so a 51%-against-50%
    // reading stops waking the down-only channels with "🔴 is down".
    const monitor = await Monitor.create({ teamId: teamId, name: 'Box', url: 'https://box.example.com', type: 'uptime', status: 'up', reportsMetrics: true })
    await attach(monitor.id, (await emailChannel('down', 'down@example.com')).id, 'down')
    await attach(monitor.id, (await emailChannel('issue', 'issue@example.com')).id, 'issue')
    await attach(monitor.id, (await emailChannel('both', 'both@example.com')).id, 'both')

    await SendIncidentNotification.handle({
      id: 10,
      monitor_id: monitor.id,
      cause: 'Host resource threshold breached: CPU 51% ≥ 50%',
      status: 'investigating',
      started_at: new Date().toISOString(),
      impacted_checks: JSON.stringify([{ type: 'server_metrics', hosts: [{ host: 'ip-172-31-12-103', breaches: ['CPU 51% ≥ 50%'] }] }]),
    })

    const to = await recipients()
    expect(to).toContain('issue@example.com')
    expect(to).toContain('both@example.com')
    expect(to).not.toContain('down@example.com')
  })

  test('a server monitor whose agent went silent is still an outage', async () => {
    // The other half of the split: no impacted_checks marker, so severity
    // falls back to the monitor type and pages the down channels.
    const monitor = await Monitor.create({ teamId: teamId, name: 'Silent', url: 'https://silent.example.com', type: 'uptime', status: 'up', reportsMetrics: true })
    await attach(monitor.id, (await emailChannel('down', 'down@example.com')).id, 'down')
    await attach(monitor.id, (await emailChannel('issue', 'issue@example.com')).id, 'issue')

    await SendIncidentNotification.handle({
      id: 11,
      monitor_id: monitor.id,
      cause: 'No agent metrics received',
      status: 'investigating',
      started_at: new Date().toISOString(),
      impacted_checks: JSON.stringify([{ type: 'missed_push', reason: 'missed_push' }]),
    })

    const to = await recipients()
    expect(to).toContain('down@example.com')
    expect(to).not.toContain('issue@example.com')
  })

  test('the routing action persists fires_on and updates it on re-save', async () => {
    const monitor = await Monitor.create({ teamId: teamId, name: 'Routing', url: 'https://example.com', type: 'uptime', status: 'up' })
    const channel = await emailChannel('chan', 'chan@example.com')
    const untouched = await emailChannel('untouched', 'untouched@example.com')

    const res = await DashboardSaveRoutingAction.handle(fakeRequest({
      monitorId: String(monitor.id),
      [`chan_${channel.id}`]: '1',
      [`fires_${channel.id}`]: 'down',
    }, token))
    expect(res.status).toBe(302)
    let link = await MonitorNotificationChannel.where('monitor_id', monitor.id).where('notification_channel_id', channel.id).first()
    expect(link!.fires_on).toBe('down')

    // A channel left unchecked is a channel the operator chose not to route to,
    // even though its fires_on select still posted a value alongside it.
    expect(await MonitorNotificationChannel.where('monitor_id', monitor.id).where('notification_channel_id', untouched.id).get()).toHaveLength(0)

    // Re-saving updates the preference rather than duplicating the row.
    await DashboardSaveRoutingAction.handle(fakeRequest({
      monitorId: String(monitor.id),
      [`chan_${channel.id}`]: '1',
      [`fires_${channel.id}`]: 'issue',
    }, token))
    const links = await MonitorNotificationChannel.where('monitor_id', monitor.id).where('notification_channel_id', channel.id).get()
    expect(links.length).toBe(1)
    expect(links[0]!.fires_on).toBe('issue')

    // An omitted preference falls back to 'both'.
    await DashboardSaveRoutingAction.handle(fakeRequest({
      monitorId: String(monitor.id),
      [`chan_${channel.id}`]: '1',
    }, token))
    link = await MonitorNotificationChannel.where('monitor_id', monitor.id).where('notification_channel_id', channel.id).first()
    expect(link!.fires_on).toBe('both')
  })

  test('unchecking a channel detaches it, so a save can silence a monitor', async () => {
    // Absence is the whole signal: an unchecked box posts nothing, so a
    // reconcile driven by the submitted fields alone would never see it and
    // the operator could attach channels but never remove one.
    const monitor = await Monitor.create({ teamId: teamId, name: 'Detach', url: 'https://example.com', type: 'uptime', status: 'up' })
    const channel = await emailChannel('detach', 'detach@example.com')
    await attach(monitor.id, channel.id, 'both')

    await DashboardSaveRoutingAction.handle(fakeRequest({ monitorId: String(monitor.id) }, token))

    expect(await MonitorNotificationChannel.where('monitor_id', monitor.id).get()).toHaveLength(0)
  })

  test('another team\'s monitor is refused, not silently rerouted', async () => {
    const monitor = await Monitor.create({ teamId: teamId + 9999, name: 'Foreign', url: 'https://example.com', type: 'uptime', status: 'up' })

    const res = await DashboardSaveRoutingAction.handle(fakeRequest({ monitorId: String(monitor.id) }, token))

    expect(res.status).toBe(403)
    await monitor.delete()
  })
})
