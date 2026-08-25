import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import DashboardCreateMonitorAction from '../../app/Actions/Monitors/DashboardCreateMonitorAction'
import DashboardDeleteMonitorAction from '../../app/Actions/Monitors/DashboardDeleteMonitorAction'
import DashboardUpdateMonitorAction from '../../app/Actions/Monitors/DashboardUpdateMonitorAction'
import CheckResult from '../../app/Models/CheckResult'
import HeartbeatMonitor from '../../app/Models/HeartbeatMonitor'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment - each feature test file
// isolates its fixtures under its own team_id / email namespace.
const SEED = 90021
const OWNER_EMAIL = `monitor-forms-owner-${SEED}@example.com`
const OTHER_EMAIL = `monitor-forms-other-${SEED}@example.com`

describe('Monitor dashboard forms (create / update / delete)', () => {
  let teamId: number
  let otherTeamId: number
  let token: string
  let otherToken: string

  /** The shape the router hands an Action: a merged input bag + credentials. */
  function fakeRequest(fields: Record<string, string | undefined>, tok?: string) {
    return { get: (key: string) => fields[key], bearerToken: () => tok, cookies: { get: () => undefined } } as any
  }

  async function teamIdByName(name: string): Promise<number | null> {
    const row = await db.selectFrom('teams').where('name', '=', name).select(['id']).executeTakeFirst()
    return row ? Number(row.id) : null
  }

  async function wipe(): Promise<void> {
    for (const name of [`Monitor Forms Team ${SEED}`, `Monitor Forms Other ${SEED}`]) {
      const id = await teamIdByName(name)
      if (!id)
        continue
      for (const monitor of await Monitor.where('team_id', id).get()) {
        for (const hb of await HeartbeatMonitor.where('monitor_id', monitor.id).get())
          await hb.delete()
        for (const cr of await CheckResult.where('monitor_id', monitor.id).get())
          await cr.delete()
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

  beforeAll(async () => {
    await wipe()
    const owner = await makeTeam(`Monitor Forms Team ${SEED}`, OWNER_EMAIL, 'Forms Owner')
    teamId = owner.teamId
    token = owner.token
    const other = await makeTeam(`Monitor Forms Other ${SEED}`, OTHER_EMAIL, 'Forms Other')
    otherTeamId = other.teamId
    otherToken = other.token
  })

  afterEach(async () => {
    for (const id of [teamId, otherTeamId]) {
      for (const monitor of await Monitor.where('team_id', id).get()) {
        for (const hb of await HeartbeatMonitor.where('monitor_id', monitor.id).get())
          await hb.delete()
        for (const cr of await CheckResult.where('monitor_id', monitor.id).get())
          await cr.delete()
        await monitor.delete()
      }
    }
  })

  afterAll(wipe)

  test('the create form persists a monitor with a stringified per-type config', async () => {
    const res = await DashboardCreateMonitorAction.handle(fakeRequest({
      name: 'Postgres',
      url: 'db.example.com',
      type: 'tcp_port',
      port: '5432',
      check_interval_seconds: '300',
      enabled: 'true',
    }, token))

    expect(res.status).toBe(302)
    const monitor = (await Monitor.where('team_id', teamId).get())[0]
    expect(monitor.name).toBe('Postgres')
    expect(monitor.type).toBe('tcp_port')
    expect(monitor.check_interval_seconds).toBe(300)
    expect(JSON.parse(monitor.config)).toEqual({ port: 5432 })
    // Redirects to the new monitor's page, not back to the form.
    expect(res.headers.get('Location')).toBe(`/dashboard/monitors/${monitor.id}?created=1`)
  })

  test('an unchecked "enabled" select actually disables the monitor', async () => {
    // The trap: `enabled: request.get('enabled') ?? true` stored the truthy
    // string "false", so a monitor the operator disabled kept being polled.
    await DashboardCreateMonitorAction.handle(fakeRequest({
      name: 'Paused', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300', enabled: 'false',
    }, token))

    const monitor = (await Monitor.where('team_id', teamId).get())[0]
    expect(monitor.enabled).toBeFalsy()
    // ...and the dispatcher's own filter agrees.
    expect((await Monitor.where('team_id', teamId).where('enabled', true).get())).toHaveLength(0)
  })

  test('invalid input redirects back to the form with a code, creating nothing', async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{ name: '', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300' }, 'name_required'],
      [{ name: 'X', url: 'https://example.com', type: 'sql', check_interval_seconds: '300' }, 'type_invalid'],
      [{ name: 'X', url: 'file:///etc/passwd', type: 'uptime', check_interval_seconds: '300' }, 'url_scheme'],
      [{ name: 'X', url: 'https://example.com', type: 'uptime', check_interval_seconds: 'soon' }, 'interval_invalid'],
    ]
    for (const [fields, code] of cases) {
      const res = await DashboardCreateMonitorAction.handle(fakeRequest(fields, token))
      expect(res.status).toBe(302)
      expect(res.headers.get('Location')).toBe(`/dashboard/monitors/new?error=${code}`)
    }
    expect(await Monitor.where('team_id', teamId).get()).toHaveLength(0)
  })

  test('the plan interval floor is enforced on create and on edit', async () => {
    // The free plan floors checks at 300s; the form must not be a way around
    // the paywall, on either entry point.
    const created = await DashboardCreateMonitorAction.handle(fakeRequest({
      name: 'Too fast', url: 'https://example.com', type: 'uptime', check_interval_seconds: '10',
    }, token))
    expect(created.headers.get('Location')).toContain('error=plan_interval')
    expect(await Monitor.where('team_id', teamId).get()).toHaveLength(0)

    const monitor = await Monitor.create({ teamId: teamId, name: 'Fine', url: 'https://example.com', type: 'uptime', checkIntervalSeconds: 300, status: 'unknown' })
    const edited = await DashboardUpdateMonitorAction.handle(fakeRequest({
      monitorId: String(monitor.id), name: 'Fine', url: 'https://example.com', type: 'uptime', check_interval_seconds: '10',
    }, token))
    expect(edited.headers.get('Location')).toContain('error=plan_interval')
    expect((await Monitor.find(monitor.id))!.check_interval_seconds).toBe(300)
  })

  test('a heartbeat monitor gets its paired row and ping token', async () => {
    // A type:'cron' Monitor alone is inert - DispatchDueChecks has no cron
    // entry and CheckOverdueHeartbeats iterates heartbeat_monitors.
    await DashboardCreateMonitorAction.handle(fakeRequest({
      name: 'Nightly backup',
      url: 'jobs.example.com',
      type: 'cron',
      check_interval_seconds: '300',
      expected_interval_seconds: '86400',
      grace_seconds: '600',
      cron_expression: '0 3 * * *',
    }, token))

    const monitor = (await Monitor.where('team_id', teamId).get())[0]
    const heartbeat = await HeartbeatMonitor.where('monitor_id', monitor.id).first()
    expect(heartbeat).toBeTruthy()
    expect(heartbeat!.expected_interval_seconds).toBe(86_400)
    expect(heartbeat!.grace_seconds).toBe(600)
    expect(heartbeat!.cron_expression).toBe('0 3 * * *')
    expect(String(heartbeat!.ping_token).length).toBeGreaterThan(16)
  })

  test('enabling metrics mints an agent token once and keeps it across saves', async () => {
    await DashboardCreateMonitorAction.handle(fakeRequest({
      name: 'Web box', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300', reports_metrics: 'on', cpu_threshold: '80',
    }, token))

    const monitor = (await Monitor.where('team_id', teamId).get())[0]
    const firstToken = (await db.selectFrom('monitors').where('id', '=', monitor.id).select(['metrics_token']).executeTakeFirst())!.metrics_token
    expect(String(firstToken).length).toBeGreaterThan(16)
    expect(JSON.parse(monitor.config)).toEqual({ cpuThreshold: 80 })

    await DashboardUpdateMonitorAction.handle(fakeRequest({
      monitorId: String(monitor.id), name: 'Web box', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300', reports_metrics: 'on',
    }, token))
    const afterToken = (await db.selectFrom('monitors').where('id', '=', monitor.id).select(['metrics_token']).executeTakeFirst())!.metrics_token
    // Rotating on every save would silently break an installed agent.
    expect(afterToken).toBe(firstToken)
  })

  test('the edit form updates fields and rewrites config for the new type', async () => {
    const monitor = await Monitor.create({
      teamId: teamId, name: 'Old', url: 'https://old.example.com', type: 'tcp_port',
      checkIntervalSeconds: 300, config: JSON.stringify({ port: 5432 }), status: 'unknown',
    })

    const res = await DashboardUpdateMonitorAction.handle(fakeRequest({
      monitorId: String(monitor.id), name: 'New', url: 'https://new.example.com', type: 'uptime',
      check_interval_seconds: '600', latency_threshold_ms: '900',
    }, token))

    expect(res.headers.get('Location')).toBe(`/dashboard/monitors/${monitor.id}?saved=1`)
    const updated = (await Monitor.find(monitor.id))!
    expect(updated.name).toBe('New')
    expect(updated.type).toBe('uptime')
    expect(updated.check_interval_seconds).toBe(600)
    // Stale per-type keys must not survive a type change.
    expect(JSON.parse(updated.config)).toEqual({ latencyThresholdMs: 900 })
  })

  test('another team cannot edit or delete a monitor it does not own', async () => {
    const monitor = await Monitor.create({ teamId: teamId, name: 'Mine', url: 'https://example.com', type: 'uptime', checkIntervalSeconds: 300, status: 'unknown' })

    const edit = await DashboardUpdateMonitorAction.handle(fakeRequest({
      monitorId: String(monitor.id), name: 'Hijacked', url: 'https://evil.example.com', type: 'uptime', check_interval_seconds: '300',
    }, otherToken))
    expect(edit.status).toBe(403)

    const remove = await DashboardDeleteMonitorAction.handle(fakeRequest({ monitorId: String(monitor.id) }, otherToken))
    expect(remove.status).toBe(403)

    const survivor = (await Monitor.find(monitor.id))!
    expect(survivor.name).toBe('Mine')
  })

  test('unauthenticated form posts are rejected', async () => {
    const res = await DashboardCreateMonitorAction.handle(fakeRequest({
      name: 'Anon', url: 'https://example.com', type: 'uptime', check_interval_seconds: '300',
    }))
    expect(res.status).toBe(401)
    expect(await Monitor.where('team_id', teamId).get()).toHaveLength(0)
  })

  test('deleting a monitor takes its dependent rows with it', async () => {
    const monitor = await Monitor.create({ teamId: teamId, name: 'Doomed', url: 'jobs.example.com', type: 'cron', checkIntervalSeconds: 300, status: 'unknown' })
    await HeartbeatMonitor.create({ monitor_id: monitor.id, pingToken: 'tok'.repeat(8), expectedIntervalSeconds: 3600, graceSeconds: 300 })
    await CheckResult.create({ monitor_id: monitor.id, status: 'up', responseTimeMs: 5, statusCode: 200, message: 'ok', region: 'default', checkedAt: new Date().toISOString() })

    const res = await DashboardDeleteMonitorAction.handle(fakeRequest({ monitorId: String(monitor.id) }, token))
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/dashboard/monitors?deleted=1')

    expect(await Monitor.find(monitor.id)).toBeFalsy()
    // A surviving heartbeat row would keep alerting on a monitor the
    // operator believes is gone; orphaned check rows would bloat the
    // largest table in the app forever.
    expect(await HeartbeatMonitor.where('monitor_id', monitor.id).get()).toHaveLength(0)
    expect(await CheckResult.where('monitor_id', monitor.id).get()).toHaveLength(0)
  })

  /**
   * The health endpoint secret was unsettable from the UI for as long as the
   * health type has existed. Every piece was in place except one: both forms
   * rendered the field, the browser posted it, buildMonitorConfig knew how to
   * store it (monitor-form.test.ts covers that directly, and passed the whole
   * time), and RunHealthCheck knew how to send it — but neither dashboard
   * action pulled `health_secret` off the request, so the library was always
   * handed undefined. The field accepted input, saved without error, and came
   * back empty, which reads as "I typed it wrong".
   *
   * The unit tests could not catch this because they call
   * buildMonitorConfig directly, which is precisely the layer that was fine.
   * These go through the actions, the layer that was not.
   */
  describe('health monitor secrets survive the round trip', () => {
    test('create stores the secret and freshness window', async () => {
      const res = await DashboardCreateMonitorAction.handle(fakeRequest({
        name: 'API health',
        url: 'https://api.example.com',
        type: 'health',
        path: '/api/health',
        health_secret: 'sh4red-s3cret',
        health_max_age_seconds: '300',
        check_interval_seconds: '300',
        enabled: 'true',
      }, token))
      expect(res.status).toBe(302)

      const monitor = (await Monitor.where('team_id', teamId).get())[0]
      expect(JSON.parse(monitor.config)).toEqual({
        path: '/api/health',
        healthSecret: 'sh4red-s3cret',
        healthMaxAgeSeconds: 300,
      })
    })

    test('update stores a secret on a monitor that had none', async () => {
      const monitor = await Monitor.create({
        teamId,
        name: 'API health',
        url: 'https://api.example.com',
        type: 'health',
        checkIntervalSeconds: 300,
        status: 'unknown',
        config: '{}',
      })

      const res = await DashboardUpdateMonitorAction.handle(fakeRequest({
        monitorId: String(monitor.id),
        name: 'API health',
        url: 'https://api.example.com',
        type: 'health',
        path: '/api/health',
        health_secret: 'sh4red-s3cret',
        health_max_age_seconds: '300',
        check_interval_seconds: '300',
        enabled: 'true',
      }, token))
      expect(res.status).toBe(302)

      const saved = await Monitor.find(monitor.id)
      expect(JSON.parse(saved!.config).healthSecret).toBe('sh4red-s3cret')
      expect(JSON.parse(saved!.config).healthMaxAgeSeconds).toBe(300)
    })

    test('switching a monitor to another type drops the secret rather than orphaning it', async () => {
      // config is rebuilt from scratch per save and only the branches
      // matching `type` are filled, so this is the existing contract rather
      // than a new behaviour — asserted so the fix above cannot be
      // "improved" into leaking a credential onto a type that never sends it.
      const monitor = await Monitor.create({
        teamId,
        name: 'API health',
        url: 'https://api.example.com',
        type: 'health',
        checkIntervalSeconds: 300,
        status: 'unknown',
        config: JSON.stringify({ path: '/api/health', healthSecret: 'sh4red-s3cret' }),
      })

      await DashboardUpdateMonitorAction.handle(fakeRequest({
        monitorId: String(monitor.id),
        name: 'API health',
        url: 'https://api.example.com',
        type: 'uptime',
        health_secret: 'sh4red-s3cret',
        check_interval_seconds: '300',
        enabled: 'true',
      }, token))

      const saved = await Monitor.find(monitor.id)
      expect(JSON.parse(saved!.config).healthSecret).toBeUndefined()
    })
  })
})
