import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import Monitor from '../../app/Models/Monitor'

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
    const mA = await Monitor.create({ team_id: teamA, name: 'Scope A monitor', url: 'https://a.example.com', type: 'uptime', status: 'unknown' })
    const mB = await Monitor.create({ team_id: teamB, name: 'Scope B monitor', url: 'https://b.example.com', type: 'uptime', status: 'unknown' })
    monitorA = mA.id
    monitorB = mB.id
  })

  afterAll(async () => {
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
})
