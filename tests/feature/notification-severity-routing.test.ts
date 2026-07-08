import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { awaitConfig, config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import DashboardAssignChannelAction from '../../app/Actions/Notifications/DashboardAssignChannelAction'
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
    return NotificationChannel.create({ team_id: teamId, name, type: 'email', config: JSON.stringify({ email: address }), enabled: true })
  }

  async function attach(monitorId: number, channelId: number, firesOn: string) {
    await MonitorNotificationChannel.create({ monitor_id: monitorId, notification_channel_id: channelId, fires_on: firesOn })
  }

  async function recipients(): Promise<string[]> {
    return CaptureEmailDriver.all().map((m: any) => String(m.to))
  }

  test('a down incident notifies down-only and both channels, not issue-only', async () => {
    const monitor = await Monitor.create({ team_id: teamId, name: 'API', url: 'https://api.example.com', type: 'uptime', status: 'up' })
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
    const monitor = await Monitor.create({ team_id: teamId, name: 'DNS', url: 'https://example.com', type: 'dns', status: 'up' })
    await attach(monitor.id, (await emailChannel('down', 'down@example.com')).id, 'down')
    await attach(monitor.id, (await emailChannel('issue', 'issue@example.com')).id, 'issue')
    await attach(monitor.id, (await emailChannel('both', 'both@example.com')).id, 'both')

    await SendIncidentNotification.handle({ id: 2, monitor_id: monitor.id, cause: 'drift', status: 'investigating', started_at: new Date().toISOString() })

    const to = await recipients()
    expect(to).toContain('issue@example.com')
    expect(to).toContain('both@example.com')
    expect(to).not.toContain('down@example.com')
  })

  test('the assign action persists fires_on and updates it on re-assign', async () => {
    const monitor = await Monitor.create({ team_id: teamId, name: 'Assign', url: 'https://example.com', type: 'uptime', status: 'up' })
    const channel = await emailChannel('chan', 'chan@example.com')

    const res = await DashboardAssignChannelAction.handle(fakeRequest({ monitorId: String(monitor.id), channel_id: String(channel.id), fires_on: 'down' }, token))
    expect(res.status).toBe(302)
    let link = await MonitorNotificationChannel.where('monitor_id', monitor.id).where('notification_channel_id', channel.id).first()
    expect(link!.fires_on).toBe('down')

    // Re-assigning the same channel updates the preference rather than duplicating.
    await DashboardAssignChannelAction.handle(fakeRequest({ monitorId: String(monitor.id), channel_id: String(channel.id), fires_on: 'issue' }, token))
    const links = await MonitorNotificationChannel.where('monitor_id', monitor.id).where('notification_channel_id', channel.id).get()
    expect(links.length).toBe(1)
    expect(links[0]!.fires_on).toBe('issue')

    // An omitted preference falls back to 'both'.
    const m2 = await Monitor.create({ team_id: teamId, name: 'Assign2', url: 'https://example.com', type: 'uptime', status: 'up' })
    await DashboardAssignChannelAction.handle(fakeRequest({ monitorId: String(m2.id), channel_id: String(channel.id) }, token))
    link = await MonitorNotificationChannel.where('monitor_id', m2.id).where('notification_channel_id', channel.id).first()
    expect(link!.fires_on).toBe('both')
  })
})
