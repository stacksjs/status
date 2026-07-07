import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import CreateMonitorAction from '../../app/Actions/Monitors/CreateMonitorAction'
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
    const monitor = await Monitor.create({ team_id: realTeamId, name: 'Read test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    createdIds.push(monitor.id)

    const found = await Monitor.find(monitor.id)
    expect(found).toBeTruthy()
    expect(found!.name).toBe('Read test')
  })

  test('update persists changed fields', async () => {
    const monitor = await Monitor.create({ team_id: realTeamId, name: 'Update test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    createdIds.push(monitor.id)

    await monitor.update({ name: 'Update test (renamed)', check_interval_seconds: 900 })
    const updated = await Monitor.find(monitor.id)

    expect(updated!.name).toBe('Update test (renamed)')
    expect(updated!.check_interval_seconds).toBe(900)
  })

  test('delete removes the monitor', async () => {
    const monitor = await Monitor.create({ team_id: realTeamId, name: 'Delete test', url: 'https://example.com', type: 'uptime', status: 'unknown' })
    await monitor.delete()

    const found = await Monitor.find(monitor.id)
    expect(found).toBeFalsy()
  })
})
