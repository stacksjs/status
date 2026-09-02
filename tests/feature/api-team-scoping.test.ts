import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import SendNotification from '../../app/Jobs/SendNotification'
import Incident from '../../app/Models/Incident'
import Monitor from '../../app/Models/Monitor'
import Server from '../../app/Models/Server'

// Framework enhancement guard: models with a `team_id` column (Monitor,
// StatusPage, …) are auto-scoped by the auto-CRUD layer to the caller's
// active team — see storage/framework/orm/routes.ts (effectiveOwnershipConfig).
// `middleware: ['auth']` only blocks anonymous access; this proves an
// AUTHENTICATED caller from team A cannot read or mutate team B's rows.
//
// Distinct email/team namespace so concurrent test files don't collide —
// see monitor-crud.test.ts's TEAM_ID comment.
const A_EMAIL = 'scope-test-owner-a-93011@example.com'
const B_EMAIL = 'scope-test-owner-b-93012@example.com'

describe('Auto-CRUD team scoping (framework enhancement)', () => {
  let teamA = 0
  let teamB = 0
  let userA = 0
  let userB = 0
  let tokenA = ''
  let monitorA = 0
  let monitorB = 0
  let serverA = 0
  let serverB = 0
  let incidentA = 0
  let incidentB = 0

  beforeAll(async () => {
    // Two teams, each owned by its own user.
    await db.insertInto('teams').values({ name: 'Scope Test Team A 93011' }).execute()
    await db.insertInto('teams').values({ name: 'Scope Test Team B 93012' }).execute()
    teamA = Number((await db.selectFrom('teams').where('name', '=', 'Scope Test Team A 93011').select(['id']).executeTakeFirst())!.id)
    teamB = Number((await db.selectFrom('teams').where('name', '=', 'Scope Test Team B 93012').select(['id']).executeTakeFirst())!.id)

    await db.insertInto('users').values({ name: 'Scope Owner A', email: A_EMAIL, password: 'x'.repeat(10) }).execute()
    await db.insertInto('users').values({ name: 'Scope Owner B', email: B_EMAIL, password: 'x'.repeat(10) }).execute()
    userA = Number((await db.selectFrom('users').where('email', '=', A_EMAIL).select(['id']).executeTakeFirst())!.id)
    userB = Number((await db.selectFrom('users').where('email', '=', B_EMAIL).select(['id']).executeTakeFirst())!.id)

    await db.insertInto('team_members').values({ team_id: teamA, user_id: userA, role: 'owner', status: 'active', invited_email: A_EMAIL }).execute()
    await db.insertInto('team_members').values({ team_id: teamB, user_id: userB, role: 'owner', status: 'active', invited_email: B_EMAIL }).execute()

    // Bearer token for team A's owner. No refresh token → single-row cleanup.
    tokenA = String((await Auth.loginUsingId(userA, { withRefreshToken: false }))!.token)

    // One monitor per team.
    const mA = await Monitor.create({ teamId: teamA, name: 'Scope A monitor', url: 'https://a.example.com', type: 'uptime', status: 'unknown' })
    const mB = await Monitor.create({ teamId: teamB, name: 'Scope B monitor', url: 'https://b.example.com', type: 'uptime', status: 'unknown' })
    monitorA = mA.id
    monitorB = mB.id

    // One box per team. Incidents have no team_id of their own — an incident
    // is its monitor's or its server's — so both hops need a fixture.
    const sA = await Server.create({ teamId: teamA, name: 'Scope A box', metricsToken: `scope-a-93011-${Math.floor(performance.now() * 1000)}` })
    const sB = await Server.create({ teamId: teamB, name: 'Scope B box', metricsToken: `scope-b-93012-${Math.floor(performance.now() * 1000)}` })
    serverA = sA.id
    serverB = sB.id

    const iA = await (Incident as any).create({ monitorId: null, serverId: serverA, startedAt: new Date().toISOString(), cause: 'A box is hot', status: 'investigating', impactedChecks: JSON.stringify([{ type: 'server_hot', hosts: [] }]) })
    const iB = await (Incident as any).create({ monitorId: monitorB, serverId: null, startedAt: new Date().toISOString(), cause: 'B site is down', status: 'investigating', impactedChecks: JSON.stringify([]) })
    incidentA = iA.id
    incidentB = iB.id
  })

  afterAll(async () => {
    // Every incident this file touched, incl. the ones its tests create, and
    // their timeline rows first — incident_updates has an FK onto incidents.
    const byServer = await db.selectFrom('incidents').where('server_id', 'in', [serverA, serverB]).select(['id']).execute()
    const byMonitor = await db.selectFrom('incidents').where('monitor_id', 'in', [monitorA, monitorB]).select(['id']).execute()
    const incidentIds = [...new Set([...byServer, ...byMonitor].map(r => Number(r.id)))]
    if (incidentIds.length > 0) {
      await db.deleteFrom('incident_updates').where('incident_id', 'in', incidentIds).execute()
      await db.deleteFrom('incidents').where('id', 'in', incidentIds).execute()
    }
    const s1 = await Server.find(serverA); if (s1) await s1.delete()
    const s2 = await Server.find(serverB); if (s2) await s2.delete()
    const m1 = await Monitor.find(monitorA); if (m1) await m1.delete()
    const m2 = await Monitor.find(monitorB); if (m2) await m2.delete()
    await db.deleteFrom('oauth_access_tokens').where('user_id', '=', userA).execute()
    await db.deleteFrom('team_members').where('team_id', '=', teamA).execute()
    await db.deleteFrom('team_members').where('team_id', '=', teamB).execute()
    await db.deleteFrom('teams').where('id', '=', teamA).execute()
    await db.deleteFrom('teams').where('id', '=', teamB).execute()
    await db.deleteFrom('users').where('id', '=', userA).execute()
    await db.deleteFrom('users').where('id', '=', userB).execute()
  })

  const authed = () => featureTest().withHeaders({ Authorization: `Bearer ${tokenA}` })

  test('index returns only the caller team\'s rows, never another team\'s', async () => {
    const res = await authed().get('/api/monitors?per_page=100')
    expect(res.status).toBe(200)
    const body = await res.json<{ data: Array<{ id: number, team_id: number }> }>()
    const ids = body.data.map(r => r.id)

    expect(ids).toContain(monitorA)
    expect(ids).not.toContain(monitorB)
    // Every row belongs to team A — no cross-tenant leakage.
    for (const row of body.data) expect(Number(row.team_id)).toBe(teamA)
    // Per-caller data must not be shared-cached.
    res.assertHeader('Cache-Control', /private/)
  })

  test('show returns the caller team\'s own row', async () => {
    const res = await authed().get(`/api/monitors/${monitorA}`)
    expect(res.status).toBe(200)
  })

  test('show 404s another team\'s row (existence not revealed)', async () => {
    const res = await authed().get(`/api/monitors/${monitorB}`)
    expect(res.status).toBe(404)
  })

  test('update 403s / 404s another team\'s row', async () => {
    const res = await authed().put(`/api/monitors/${monitorB}`, { name: 'hijacked' })
    // Cross-team write is refused (403 from the ownership guard).
    expect([403, 404]).toContain(res.status)
    // And the row is untouched.
    const still = await Monitor.find(monitorB)
    expect(still!.name).toBe('Scope B monitor')
  })

  test('delete 403s / 404s another team\'s row', async () => {
    const res = await authed().delete(`/api/monitors/${monitorB}`)
    expect([403, 404]).toContain(res.status)
    const still = await Monitor.find(monitorB)
    expect(still).toBeTruthy()
  })

  // --- Incident store/update overrides (SERVER-MODEL-SPEC.md §4.9) ---------
  //
  // `incidents` has no team_id column, so the auto-CRUD team scoping the tests
  // above exercise never engaged for this model: the generated store and
  // update accepted ANY monitor_id / server_id from any authenticated caller,
  // and `observe: true` turned that into a cross-tenant paging vector — the
  // created incident's `cause`, chosen by the attacker, fanned out over the
  // named row's team's channels. routes/api.ts overrides both.

  /** Count the SendNotification.dispatch calls a block makes. */
  async function dispatches(fn: () => Promise<unknown>): Promise<number> {
    const original = (SendNotification as any).dispatch
    let calls = 0
    ;(SendNotification as any).dispatch = async () => {
      calls++
    }
    try {
      await fn()
    }
    finally {
      ;(SendNotification as any).dispatch = original
    }
    return calls
  }

  const incidentCount = async () => (await db.selectFrom('incidents').select(['id']).execute()).length

  test('POST /incidents with another team\'s server_id is refused, and pages nobody', async () => {
    const before = await incidentCount()
    let res: any

    const calls = await dispatches(async () => {
      res = await authed().post('/api/incidents', {
        monitor_id: null,
        server_id: serverB,
        cause: 'ATTACKER TEXT: call 1-800-EVIL immediately',
        status: 'investigating',
        started_at: new Date().toISOString(),
        impacted_checks: JSON.stringify([{ type: 'server_hot', hosts: [{ host: 'web-01', breaches: ['CPU 99% \u2265 90%'] }] }]),
      })
    })

    expect(res.status).toBe(403)
    // No row written, so no incident:created, so no fan-out over team B.
    expect(await incidentCount()).toBe(before)
    expect(calls).toBe(0)
  })

  test('POST /incidents with another team\'s monitor_id is refused', async () => {
    const before = await incidentCount()
    const res = await authed().post('/api/incidents', {
      monitor_id: monitorB,
      cause: 'ATTACKER TEXT',
      status: 'investigating',
      started_at: new Date().toISOString(),
    })

    expect(res.status).toBe(403)
    expect(await incidentCount()).toBe(before)
  })

  test('POST /incidents with both or neither of monitor_id and server_id is 422', async () => {
    const both = await authed().post('/api/incidents', { monitor_id: monitorA, server_id: serverA, cause: 'x', started_at: new Date().toISOString() })
    expect(both.status).toBe(422)

    const neither = await authed().post('/api/incidents', { cause: 'x', started_at: new Date().toISOString() })
    expect(neither.status).toBe(422)
  })

  test('POST /incidents against the caller\'s own server is allowed', async () => {
    const res = await authed().post('/api/incidents', {
      server_id: serverA,
      cause: 'Our own box is hot',
      status: 'investigating',
      started_at: new Date().toISOString(),
      impacted_checks: JSON.stringify([{ type: 'server_hot', hosts: [] }]),
    })

    expect(res.status).toBe(201)
    const body = await res.json<{ id: number, server_id: number | null, monitor_id: number | null }>()
    expect(Number(body.server_id)).toBe(serverA)
    expect(body.monitor_id ?? null).toBeNull()
  })

  test('PATCH /incidents/{id} cannot re-point an incident at another team\'s server', async () => {
    const res = await authed().patch(`/api/incidents/${incidentA}`, { server_id: serverB, cause: 'moved' })
    expect(res.status).toBe(422)

    const still = await Incident.find(incidentA)
    expect(Number(still!.server_id)).toBe(serverA)
    expect(still!.cause).toBe('A box is hot')
  })

  test('PATCH /incidents/{id} 404s another team\'s incident', async () => {
    const res = await authed().patch(`/api/incidents/${incidentB}`, { cause: 'hijacked' })
    expect(res.status).toBe(404)

    const still = await Incident.find(incidentB)
    expect(still!.cause).toBe('B site is down')
  })

  test('PATCH /incidents/{id} updates the caller\'s own incident', async () => {
    const res = await authed().patch(`/api/incidents/${incidentA}`, { status: 'monitoring' })
    expect(res.status).toBe(200)

    const still = await Incident.find(incidentA)
    expect(still!.status).toBe('monitoring')
    // A PATCH carrying only `status` must not blank the other fields.
    expect(still!.cause).toBe('A box is hot')
  })

  test('POST /incidents/{id}/acknowledge works for a server-keyed incident', async () => {
    // Every incident the server state machine opens has monitor_id null, so
    // an ownership check that only ever looked at `monitors` answered
    // 'not found' to the box's rightful owner for both box-level kinds.
    const incident = await (Incident as any).create({
      monitorId: null,
      serverId: serverA,
      startedAt: new Date().toISOString(),
      cause: 'Agent went quiet',
      status: 'investigating',
      impactedChecks: JSON.stringify([{ type: 'server_silent', reason: 'missed_push', windowSeconds: 300 }]),
    })

    const res = await authed().post(`/api/incidents/${incident.id}/acknowledge`, {})
    expect(res.status).toBe(200)
    const body = await res.json<{ success: boolean, message: string }>()
    expect(body.success).toBe(true)
    expect(body.message).toBe(`Incident ${incident.id} acknowledged`)
    expect((await Incident.find(incident.id))!.status).toBe('identified')
  })

  test('POST /incidents/{id}/acknowledge still 404-messages another team\'s server incident', async () => {
    const incident = await (Incident as any).create({
      monitorId: null,
      serverId: serverB,
      startedAt: new Date().toISOString(),
      cause: 'B box is hot',
      status: 'investigating',
      impactedChecks: JSON.stringify([{ type: 'server_hot', hosts: [] }]),
    })

    const res = await authed().post(`/api/incidents/${incident.id}/acknowledge`, {})
    const body = await res.json<{ success: boolean, message: string }>()
    expect(body.success).toBe(false)
    expect(body.message).toBe(`Incident ${incident.id} not found`)
    expect((await Incident.find(incident.id))!.status).toBe('investigating')
  })
})
