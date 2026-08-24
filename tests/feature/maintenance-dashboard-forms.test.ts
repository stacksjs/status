import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import DashboardAttachMaintenanceMonitorAction from '../../app/Actions/Maintenance/DashboardAttachMaintenanceMonitorAction'
import DashboardCreateMaintenanceWindowAction from '../../app/Actions/Maintenance/DashboardCreateMaintenanceWindowAction'
import DashboardDeleteMaintenanceWindowAction from '../../app/Actions/Maintenance/DashboardDeleteMaintenanceWindowAction'
import DashboardRemoveMaintenanceMonitorAction from '../../app/Actions/Maintenance/DashboardRemoveMaintenanceMonitorAction'
import DashboardUpdateMaintenanceWindowAction from '../../app/Actions/Maintenance/DashboardUpdateMaintenanceWindowAction'
import { isMonitorInMaintenance } from '../../app/lib/maintenance'
import MaintenanceWindow from '../../app/Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../app/Models/MaintenanceWindowMonitor'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id / email namespace.
const SEED = 90055
const OWNER_EMAIL = `maint-forms-owner-${SEED}@example.com`
const OTHER_EMAIL = `maint-forms-other-${SEED}@example.com`

describe('Maintenance window dashboard forms', () => {
  let teamId: number
  let otherTeamId: number
  let token: string
  let otherToken: string
  let monitorId: number
  let otherMonitorId: number

  /** The shape the router hands an Action: a merged input bag + credentials. */
  function fakeRequest(fields: Record<string, string | undefined>, tok?: string) {
    return { get: (key: string) => fields[key], bearerToken: () => tok, cookies: { get: () => undefined } } as any
  }

  async function teamIdByName(name: string): Promise<number | null> {
    const row = await db.selectFrom('teams').where('name', '=', name).select(['id']).executeTakeFirst()
    return row ? Number(row.id) : null
  }

  async function wipe(): Promise<void> {
    for (const name of [`Maint Forms Team ${SEED}`, `Maint Forms Other ${SEED}`]) {
      const id = await teamIdByName(name)
      if (!id)
        continue
      // Children before parents: maintenance_window_monitors references both
      // the window and the monitor, so both parents wait on it.
      for (const win of await MaintenanceWindow.where('team_id', id).get()) {
        for (const link of await MaintenanceWindowMonitor.where('maintenance_window_id', (win as any).id).get())
          await (link as any).delete()
        await (win as any).delete()
      }
      for (const monitor of await Monitor.where('team_id', id).get()) {
        for (const link of await MaintenanceWindowMonitor.where('monitor_id', monitor.id).get())
          await (link as any).delete()
        await monitor.delete()
      }
      await db.deleteFrom('team_members').where('team_id', '=', id).execute()
      await db.deleteFrom('teams').where('id', '=', id).execute()
    }
    for (const email of [OWNER_EMAIL, OTHER_EMAIL])
      await db.deleteFrom('users').where('email', '=', email).execute()
  }

  async function makeTeam(teamName: string, email: string, userName: string): Promise<{ teamId: number, token: string }> {
    await db.insertInto('teams').values({ name: teamName }).execute()
    const tid = (await teamIdByName(teamName))!
    await db.insertInto('users').values({ name: userName, email, password: 'x'.repeat(10) }).execute()
    const userId = Number((await db.selectFrom('users').where('email', '=', email).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('team_members').values({ team_id: tid, user_id: userId, role: 'owner', status: 'active', invited_email: email }).execute()
    const tok = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)
    return { teamId: tid, token: tok }
  }

  /** A window covering "now", so suppression is observable without waiting. */
  function nowWindowFields(overrides: Record<string, string | undefined> = {}) {
    const start = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 16)
    const end = new Date(Date.now() + 30 * 60_000).toISOString().slice(0, 16)
    return { title: 'Database upgrade', starts_at: start, ends_at: end, ...overrides }
  }

  async function createWindow(fields: Record<string, string | undefined>, tok: string) {
    const res: any = await DashboardCreateMaintenanceWindowAction.handle(fakeRequest(fields, tok))
    const location = res?.headers?.get?.('Location') ?? ''
    const match = /\/dashboard\/maintenance\/(\d+)/.exec(location)
    return { res, location, id: match ? Number(match[1]) : null }
  }

  beforeAll(async () => {
    await wipe()
    const owner = await makeTeam(`Maint Forms Team ${SEED}`, OWNER_EMAIL, 'Maint Owner')
    teamId = owner.teamId
    token = owner.token
    const other = await makeTeam(`Maint Forms Other ${SEED}`, OTHER_EMAIL, 'Maint Other')
    otherTeamId = other.teamId
    otherToken = other.token

    const mine = await Monitor.create({ teamId, name: `maint-mine-${SEED}`, url: 'https://example.com', type: 'uptime', enabled: true })
    monitorId = mine.id
    const theirs = await Monitor.create({ teamId: otherTeamId, name: `maint-theirs-${SEED}`, url: 'https://example.org', type: 'uptime', enabled: true })
    otherMonitorId = theirs.id
  })

  /**
   * Windows only — the teams, users and monitors are built once in
   * beforeAll and shared. This matters more here than in most suites:
   * coverage is a property of the MONITOR, not of the window under test, so
   * a window left attached by an earlier test keeps
   * isMonitorInMaintenance() true and every later assertion about
   * detaching, cancelling or deleting reads as a product bug. (It did,
   * before this hook existed.)
   */
  afterEach(async () => {
    for (const id of [teamId, otherTeamId]) {
      for (const win of await MaintenanceWindow.where('team_id', id).get()) {
        for (const link of await MaintenanceWindowMonitor.where('maintenance_window_id', (win as any).id).get())
          await (link as any).delete()
        await (win as any).delete()
      }
    }
  })

  afterAll(async () => {
    await wipe()
  })

  describe('creating', () => {
    test('a signed-in owner can schedule a window, and it lands on their own team', async () => {
      const { res, id } = await createWindow(nowWindowFields(), token)
      expect(res.status).toBe(302)
      expect(id).toBeGreaterThan(0)

      const saved = await MaintenanceWindow.find(id!)
      expect(saved).toBeTruthy()
      expect((saved as any).team_id).toBe(teamId)
      expect((saved as any).title).toBe('Database upgrade')
      expect((saved as any).status).toBe('scheduled')
    })

    test('team_id is taken from the session, not the form — posting another team\'s id does not move it', async () => {
      const { id } = await createWindow({ ...nowWindowFields(), team_id: String(otherTeamId) } as any, token)
      const saved = await MaintenanceWindow.find(id!)
      expect((saved as any).team_id).toBe(teamId)
    })

    test('an anonymous caller cannot schedule anything', async () => {
      const res: any = await DashboardCreateMaintenanceWindowAction.handle(fakeRequest(nowWindowFields(), undefined))
      expect(res.status).toBe(401)
    })

    test('a backwards window is rejected with a code the form can explain', async () => {
      const res: any = await DashboardCreateMaintenanceWindowAction.handle(fakeRequest({
        title: 'Backwards',
        starts_at: '2026-09-01T04:00',
        ends_at: '2026-09-01T02:00',
      }, token))
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toContain('error=ends_before_starts')
    })

    test('an invalid recurrence is rejected rather than silently stored as a window that never fires', async () => {
      const res: any = await DashboardCreateMaintenanceWindowAction.handle(fakeRequest(
        nowWindowFields({ recurrence_cron: 'every other sunday' }),
        token,
      ))
      expect(res.headers.get('Location')).toContain('error=cron_invalid')
    })
  })

  describe('attaching monitors', () => {
    test('attaching a monitor actually suppresses it — the point of the whole feature', async () => {
      const { id } = await createWindow(nowWindowFields(), token)

      // Before attaching, the window covers nothing.
      expect(await isMonitorInMaintenance(monitorId)).toBe(false)

      await DashboardAttachMaintenanceMonitorAction.handle(
        fakeRequest({ id: String(id), monitor_id: String(monitorId) }, token),
      )

      expect(await isMonitorInMaintenance(monitorId)).toBe(true)
    })

    test('detaching restores alerting', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      await DashboardAttachMaintenanceMonitorAction.handle(fakeRequest({ id: String(id), monitor_id: String(monitorId) }, token))
      expect(await isMonitorInMaintenance(monitorId)).toBe(true)

      await DashboardRemoveMaintenanceMonitorAction.handle(fakeRequest({ id: String(id), monitor_id: String(monitorId) }, token))
      expect(await isMonitorInMaintenance(monitorId)).toBe(false)
    })

    test('attaching twice does not create a duplicate link', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      const fields = { id: String(id), monitor_id: String(monitorId) }
      await DashboardAttachMaintenanceMonitorAction.handle(fakeRequest(fields, token))
      await DashboardAttachMaintenanceMonitorAction.handle(fakeRequest(fields, token))

      const links = await MaintenanceWindowMonitor.where('maintenance_window_id', id!).where('monitor_id', monitorId).get()
      expect(links.length).toBe(1)
    })

    /**
     * The sharp edge: a maintenance window SILENCES alerting. Letting one
     * team attach another team's monitor would be a way to stop someone
     * else being paged for a real outage.
     */
    test('a monitor belonging to another team cannot be pulled into my window', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      const res: any = await DashboardAttachMaintenanceMonitorAction.handle(
        fakeRequest({ id: String(id), monitor_id: String(otherMonitorId) }, token),
      )
      expect(res.status).toBe(403)
      expect(await isMonitorInMaintenance(otherMonitorId)).toBe(false)
    })

    test('another team cannot attach anything to my window', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      const res: any = await DashboardAttachMaintenanceMonitorAction.handle(
        fakeRequest({ id: String(id), monitor_id: String(otherMonitorId) }, otherToken),
      )
      expect(res.status).toBe(403)
    })
  })

  describe('updating', () => {
    test('an owner can edit the window', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      const res: any = await DashboardUpdateMaintenanceWindowAction.handle(fakeRequest({
        id: String(id),
        title: 'Renamed upgrade',
        description: 'Now with detail.',
        starts_at: '2026-09-01T02:00',
        ends_at: '2026-09-01T04:00',
        status: 'scheduled',
      }, token))
      expect(res.status).toBe(302)

      const saved = await MaintenanceWindow.find(id!)
      expect((saved as any).title).toBe('Renamed upgrade')
      expect((saved as any).starts_at).toBe('2026-09-01T02:00:00.000Z')
    })

    /**
     * Cancelling is the operationally meaningful status: a cancelled window
     * means the work did not happen, so app/lib/maintenance.ts deliberately
     * resumes counting its time and paging. Without a UI this was
     * unreachable.
     */
    test('cancelling a live window resumes alerting for its monitors', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      await DashboardAttachMaintenanceMonitorAction.handle(fakeRequest({ id: String(id), monitor_id: String(monitorId) }, token))
      expect(await isMonitorInMaintenance(monitorId)).toBe(true)

      const current = await MaintenanceWindow.find(id!)
      await DashboardUpdateMaintenanceWindowAction.handle(fakeRequest({
        id: String(id),
        title: (current as any).title,
        starts_at: (current as any).starts_at,
        ends_at: (current as any).ends_at,
        status: 'cancelled',
      }, token))

      expect(await isMonitorInMaintenance(monitorId)).toBe(false)
    })

    /**
     * Clearing has to work in both directions. The ORM's update type takes
     * `string | undefined` and `undefined` means "leave alone", so a naive
     * mapping of the parser's null would let you make a window recurring
     * but never turn it back — the action writes '' instead, which every
     * consumer treats as "no recurrence".
     */
    test('blanking the recurrence turns a repeating window back into a one-off', async () => {
      const { id } = await createWindow(nowWindowFields({ recurrence_cron: '0 2 * * 0' }), token)
      expect((await MaintenanceWindow.find(id!) as any).recurrence_cron).toBe('0 2 * * 0')

      const current = await MaintenanceWindow.find(id!)
      await DashboardUpdateMaintenanceWindowAction.handle(fakeRequest({
        id: String(id),
        title: (current as any).title,
        starts_at: (current as any).starts_at,
        ends_at: (current as any).ends_at,
        recurrence_cron: '',
        status: 'scheduled',
      }, token))

      const after = await MaintenanceWindow.find(id!)
      expect((after as any).recurrence_cron || null).toBeNull()

      // And the schedule really did collapse to a single occurrence.
      const { expandWindowIntervals } = await import('../../app/lib/maintenance')
      const occ = expandWindowIntervals(
        { starts_at: (after as any).starts_at, ends_at: (after as any).ends_at, recurrence_cron: (after as any).recurrence_cron },
        Date.now() - 86400000,
        Date.now() + 60 * 86400000,
      )
      expect(occ.length).toBe(1)
    })

    test('another team cannot edit my window', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      const res: any = await DashboardUpdateMaintenanceWindowAction.handle(fakeRequest({
        id: String(id),
        title: 'Hijacked',
        starts_at: '2026-09-01T02:00',
        ends_at: '2026-09-01T04:00',
      }, otherToken))
      expect(res.status).toBe(403)

      const saved = await MaintenanceWindow.find(id!)
      expect((saved as any).title).not.toBe('Hijacked')
    })
  })

  describe('deleting', () => {
    test('deleting removes the window and its monitor links', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      await DashboardAttachMaintenanceMonitorAction.handle(fakeRequest({ id: String(id), monitor_id: String(monitorId) }, token))

      const res: any = await DashboardDeleteMaintenanceWindowAction.handle(fakeRequest({ id: String(id) }, token))
      expect(res.status).toBe(302)

      expect(await MaintenanceWindow.find(id!)).toBeFalsy()
      const links = await MaintenanceWindowMonitor.where('maintenance_window_id', id!).get()
      expect(links.length).toBe(0)
      // The monitor itself survives; only its coverage went away.
      expect(await Monitor.find(monitorId)).toBeTruthy()
      expect(await isMonitorInMaintenance(monitorId)).toBe(false)
    })

    test('another team cannot delete my window', async () => {
      const { id } = await createWindow(nowWindowFields(), token)
      const res: any = await DashboardDeleteMaintenanceWindowAction.handle(fakeRequest({ id: String(id) }, otherToken))
      expect(res.status).toBe(403)
      expect(await MaintenanceWindow.find(id!)).toBeTruthy()
    })
  })
})
