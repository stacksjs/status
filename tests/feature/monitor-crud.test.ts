import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import CreateMonitorAction from '../../app/Actions/Monitors/CreateMonitorAction'
import HeartbeatMonitor from '../../app/Models/HeartbeatMonitor'
import Monitor from '../../app/Models/Monitor'

// A distinct, high seed value — not shared with other feature test files.
// Bun runs test files concurrently by default; if every file's fixtures
// shared a team, CreateMonitorAction's free-tier plan-limit check (5
// monitors) would count monitors created by OTHER files running at the
// same time and 402 unpredictably. Each file owns its own real team
// (autoincrement id, resolved in beforeAll) to keep counts independent.
const SEED = 90001
const OWNER_EMAIL = `monitor-crud-owner-${SEED}@example.com`

describe('Monitor CRUD (stacksjs/status#1 Phase 1)', () => {
  const createdIds: number[] = []
  let realTeamId: number
  let ownerUserId: number
  // A real access token for the owner — CreateMonitorAction now derives the
  // owning team from the credential (never a client-supplied team_id), so the
  // create path must authenticate like the billing actions do.
  let ownerToken: string

  // Mirrors billing-checkout.test.ts's fakeRequest: get() for form fields,
  // bearerToken() for the credential, cookies.get() for the session fallback.
  function fakeRequest(fields: Record<string, string | undefined>, token?: string) {
    return {
      get: (key: string) => fields[key],
      bearerToken: () => token,
      cookies: { get: () => undefined },
    } as any
  }

  beforeAll(async () => {
    await db.insertInto('teams').values({ name: `Monitor CRUD Team ${SEED}` }).execute()
    const team = await db.selectFrom('teams').where('name', '=', `Monitor CRUD Team ${SEED}`).select(['id']).executeTakeFirst()
    realTeamId = Number(team!.id)

    await db.insertInto('users').values({ name: 'Monitor CRUD Owner', email: OWNER_EMAIL, password: 'x'.repeat(10) }).execute()
    const user = await db.selectFrom('users').where('email', '=', OWNER_EMAIL).select(['id']).executeTakeFirst()
    ownerUserId = Number(user!.id)

    await db.insertInto('team_members').values({
      team_id: realTeamId,
      user_id: ownerUserId,
      role: 'owner',
      status: 'active',
      invited_email: OWNER_EMAIL,
    }).execute()

    const login = await Auth.loginUsingId(ownerUserId, { withRefreshToken: false })
    ownerToken = String(login!.token)
  })

  afterAll(async () => {
    for (const id of createdIds) {
      const monitor = await Monitor.find(id)
      if (monitor) await monitor.delete()
    }
    await db.deleteFrom('oauth_access_tokens').where('user_id', '=', ownerUserId).execute()
    await db.deleteFrom('team_members').where('team_id', '=', realTeamId).execute()
    await db.deleteFrom('teams').where('id', '=', realTeamId).execute()
    await db.deleteFrom('users').where('id', '=', ownerUserId).execute()
  })

  test('create persists a monitor with the given fields', async () => {
    // check_interval_seconds must clear the free-tier floor
    // (checkIntervalFloorSeconds: 300 in config/plans.ts) — omitting it
    // defaults to 60s, which is itself a real 402 (a different one than
    // the monitor-count limit this test isn't exercising).
    const response = await CreateMonitorAction.handle(fakeRequest({
      team_id: String(realTeamId),
      name: 'CRUD test monitor',
      url: 'https://example.com',
      type: 'uptime',
      check_interval_seconds: '300',
    }, ownerToken))
    expect(response.status).toBe(201)

    const body = await response.json() as { id: number, name: string, url: string, type: string }
    createdIds.push(body.id)

    expect(body.name).toBe('CRUD test monitor')
    expect(body.url).toBe('https://example.com')
    expect(body.type).toBe('uptime')
  })

  test('401s an unauthenticated create even with a valid team_id', async () => {
    // The team is derived from the credential, not the body, so a request
    // with no token is rejected before any monitor is created (IDOR guard).
    const response = await CreateMonitorAction.handle(fakeRequest({ team_id: String(realTeamId), name: 'nope', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300' }))
    expect(response.status).toBe(401)
  })

  test('403s when the posted team_id does not match the authed team', async () => {
    const response = await CreateMonitorAction.handle(fakeRequest({ team_id: '999999999', name: 'nope', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300' }, ownerToken))
    expect(response.status).toBe(403)
  })

  test('read returns the persisted monitor', async () => {
    const monitor = await Monitor.create({ teamId: realTeamId, name: 'Read test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    createdIds.push(monitor.id)

    const found = await Monitor.find(monitor.id)
    expect(found).toBeTruthy()
    expect(found!.name).toBe('Read test')
  })

  test('update persists changed fields', async () => {
    const monitor = await Monitor.create({ teamId: realTeamId, name: 'Update test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    createdIds.push(monitor.id)

    await monitor.update({ name: 'Update test (renamed)', check_interval_seconds: 900 })
    const updated = await Monitor.find(monitor.id)

    expect(updated!.name).toBe('Update test (renamed)')
    expect(updated!.check_interval_seconds).toBe(900)
  })

  test('delete removes the monitor', async () => {
    const monitor = await Monitor.create({ teamId: realTeamId, name: 'Delete test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    await monitor.delete()

    const found = await Monitor.find(monitor.id)
    expect(found).toBeFalsy()
  })

  /**
   * A 'cron' monitor is watched by CheckOverdueHeartbeats, which iterates
   * HeartbeatMonitor rows — not by DispatchDueChecks, which has no cron
   * entry. So a cron monitor created without its heartbeat row is inert: it
   * has no ping URL, nothing ever polls it, and it can never alert. The
   * dashboard form paired the row; this endpoint did not.
   */
  describe('cron monitors get their heartbeat row', () => {
    // The free tier caps a team at 5 monitors (config/plans.ts), and the
    // tests above leave several behind, so each case here drops its own
    // monitor rather than 402-ing the next one.
    afterEach(async () => {
      for (const id of createdIds.splice(0)) {
        for (const hb of await HeartbeatMonitor.where('monitor_id', id).get())
          await hb.delete()
        const monitor = await Monitor.find(id)
        if (monitor)
          await monitor.delete()
      }
    })

    async function createCron(fields: Record<string, string | undefined> = {}) {
      const response: any = await CreateMonitorAction.handle(fakeRequest({
        name: `Cron via API ${Object.keys(fields).join('-') || 'defaults'}`,
        url: 'jobs.example.com',
        type: 'cron',
        check_interval_seconds: '300',
        ...fields,
      }, ownerToken))
      expect(response.status).toBe(201)
      const monitor = await response.json()
      createdIds.push(monitor.id)
      const heartbeat = await HeartbeatMonitor.where('monitor_id', monitor.id).first()
      return { monitor, heartbeat }
    }

    test('pairs a heartbeat row with a usable ping token', async () => {
      const { monitor, heartbeat } = await createCron()
      expect(monitor.type).toBe('cron')
      expect(heartbeat).toBeTruthy()
      // The token IS the endpoint's only credential; without it the monitor
      // has no ping URL at all.
      expect(String(heartbeat!.ping_token).length).toBeGreaterThan(16)
      expect(heartbeat!.ping_token).not.toContain('-')
    })

    test('applies the documented defaults', async () => {
      const { heartbeat } = await createCron()
      expect(heartbeat!.expected_interval_seconds).toBe(3600)
      expect(heartbeat!.grace_seconds).toBe(300)
      expect(heartbeat!.cron_expression).toBeFalsy()
    })

    test('honors explicit cadence, grace and cron expression', async () => {
      const { heartbeat } = await createCron({
        expected_interval_seconds: '86400',
        grace_seconds: '600',
        cron_expression: '0 3 * * *',
      })
      expect(heartbeat!.expected_interval_seconds).toBe(86_400)
      expect(heartbeat!.grace_seconds).toBe(600)
      expect(heartbeat!.cron_expression).toBe('0 3 * * *')
    })

    test('non-cron monitors get no heartbeat row', async () => {
      const response: any = await CreateMonitorAction.handle(fakeRequest({
        name: 'Plain uptime via API',
        url: 'https://example.com',
        type: 'uptime',
        check_interval_seconds: '300',
      }, ownerToken))
      const monitor = await response.json()
      createdIds.push(monitor.id)
      expect(await HeartbeatMonitor.where('monitor_id', monitor.id).first()).toBeFalsy()
    })
  })

  /**
   * metrics_token is hidden:true, so the auto-CRUD layer strips it from write
   * bodies. Nothing else mints one, so a metrics monitor created here used to
   * have no credential and could never accept an agent push.
   */
  test('a metrics-reporting monitor is created with an ingest token', async () => {
    // Same free-tier headroom problem as the cron cases above.
    for (const id of createdIds.splice(0)) {
      const stale = await Monitor.find(id)
      if (stale) await stale.delete()
    }
    const response: any = await CreateMonitorAction.handle(fakeRequest({
      name: 'Metrics via API',
      url: 'https://example.com',
      type: 'uptime',
      check_interval_seconds: '300',
      reports_metrics: 'true',
    }, ownerToken))
    expect(response.status).toBe(201)
    const created = await response.json()
    createdIds.push(created.id)

    const monitor = await Monitor.find(created.id)
    expect(monitor!.reports_metrics).toBeTruthy()
    expect(String(monitor!.metrics_token).length).toBeGreaterThan(16)
  })
})
