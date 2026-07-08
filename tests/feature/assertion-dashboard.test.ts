import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import DashboardCreateAssertionAction from '../../app/Actions/Assertions/DashboardCreateAssertionAction'
import DashboardRemoveAssertionAction from '../../app/Actions/Assertions/DashboardRemoveAssertionAction'
import Assertion from '../../app/Models/Assertion'
import Monitor from '../../app/Models/Monitor'

const SEED = 90016
const OWNER_EMAIL = `assert-dash-owner-${SEED}@example.com`

describe('Assertion dashboard forms (stacksjs/status#1)', () => {
  let teamId: number
  let userId: number
  let token: string

  function fakeRequest(fields: Record<string, string | undefined>, tok?: string) {
    return { get: (key: string) => fields[key], bearerToken: () => tok, cookies: { get: () => undefined } } as any
  }

  async function cleanupTeam(): Promise<void> {
    const team = await db.selectFrom('teams').where('name', '=', `Assert Dash Team ${SEED}`).select(['id']).executeTakeFirst()
    if (team) {
      teamId = Number(team.id)
      for (const monitor of await Monitor.where('team_id', teamId).get()) {
        for (const a of await Assertion.where('monitor_id', monitor.id).get())
          await a.delete()
        await monitor.delete()
      }
      await db.deleteFrom('team_members').where('team_id', '=', teamId).execute()
      await db.deleteFrom('teams').where('id', '=', teamId).execute()
    }
    await db.deleteFrom('users').where('email', '=', OWNER_EMAIL).execute()
  }

  beforeAll(async () => {
    await cleanupTeam()
    await db.insertInto('teams').values({ name: `Assert Dash Team ${SEED}` }).execute()
    teamId = Number((await db.selectFrom('teams').where('name', '=', `Assert Dash Team ${SEED}`).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('users').values({ name: 'Assert Owner', email: OWNER_EMAIL, password: 'x'.repeat(10) }).execute()
    userId = Number((await db.selectFrom('users').where('email', '=', OWNER_EMAIL).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('team_members').values({ team_id: teamId, user_id: userId, role: 'owner', status: 'active', invited_email: OWNER_EMAIL }).execute()
    token = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)
  })

  afterEach(async () => {
    for (const monitor of await Monitor.where('team_id', teamId).get()) {
      for (const a of await Assertion.where('monitor_id', monitor.id).get())
        await a.delete()
      await monitor.delete()
    }
  })

  afterAll(cleanupTeam)

  async function healthMonitor() {
    return Monitor.create({ team_id: teamId, name: 'H', url: 'https://example.com', type: 'health', status: 'up' })
  }

  test('the create form adds a dot-path body assertion', async () => {
    const monitor = await healthMonitor()
    const res = await DashboardCreateAssertionAction.handle(fakeRequest({
      monitorId: String(monitor.id),
      target: 'body',
      property: 'checks.database.latency_ms',
      compare: 'lt',
      expected: '100',
    }, token))
    expect(res.status).toBe(302)

    const rows = await Assertion.where('monitor_id', monitor.id).get()
    expect(rows.length).toBe(1)
    expect(rows[0]!.target).toBe('body')
    expect(rows[0]!.property).toBe('checks.database.latency_ms')
    expect(rows[0]!.compare).toBe('lt')
    expect(rows[0]!.expected).toBe('100')
  })

  test('an invalid target or compare is rejected (no row created)', async () => {
    const monitor = await healthMonitor()
    await DashboardCreateAssertionAction.handle(fakeRequest({ monitorId: String(monitor.id), target: 'nonsense', compare: 'lt', expected: '1' }, token))
    await DashboardCreateAssertionAction.handle(fakeRequest({ monitorId: String(monitor.id), target: 'body', compare: 'bogus', expected: '1' }, token))
    expect((await Assertion.where('monitor_id', monitor.id).get()).length).toBe(0)
  })

  test('the remove form deletes an assertion', async () => {
    const monitor = await healthMonitor()
    const assertion = await Assertion.create({ monitor_id: monitor.id, target: 'status_code', property: null, compare: 'eq', expected: '200', sort_order: 0 })

    const res = await DashboardRemoveAssertionAction.handle(fakeRequest({ monitorId: String(monitor.id), assertion_id: String(assertion.id) }, token))
    expect(res.status).toBe(302)
    expect((await Assertion.where('monitor_id', monitor.id).get()).length).toBe(0)
  })

  test("another team's owner cannot add to or remove from this monitor", async () => {
    const monitor = await healthMonitor()
    const assertion = await Assertion.create({ monitor_id: monitor.id, target: 'status_code', property: null, compare: 'eq', expected: '200', sort_order: 0 })

    const otherEmail = `assert-dash-intruder-${SEED}@example.com`
    await db.insertInto('teams').values({ name: `Assert Dash Intruder ${SEED}` }).execute()
    const otherTeamId = Number((await db.selectFrom('teams').where('name', '=', `Assert Dash Intruder ${SEED}`).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('users').values({ name: 'Intruder', email: otherEmail, password: 'x'.repeat(10) }).execute()
    const otherUserId = Number((await db.selectFrom('users').where('email', '=', otherEmail).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('team_members').values({ team_id: otherTeamId, user_id: otherUserId, role: 'owner', status: 'active', invited_email: otherEmail }).execute()
    const otherToken = String((await Auth.loginUsingId(otherUserId, { withRefreshToken: false }))!.token)

    try {
      const addRes = await DashboardCreateAssertionAction.handle(fakeRequest({ monitorId: String(monitor.id), target: 'body', property: 'x', compare: 'eq', expected: '1' }, otherToken))
      expect(addRes.status).toBe(403)
      const rmRes = await DashboardRemoveAssertionAction.handle(fakeRequest({ monitorId: String(monitor.id), assertion_id: String(assertion.id) }, otherToken))
      expect(rmRes.status).toBe(403)
      // The original assertion is untouched.
      expect((await Assertion.where('monitor_id', monitor.id).get()).length).toBe(1)
    }
    finally {
      await db.deleteFrom('team_members').where('user_id', '=', otherUserId).execute()
      await db.deleteFrom('users').where('id', '=', otherUserId).execute()
      await db.deleteFrom('teams').where('id', '=', otherTeamId).execute()
    }
  })
})
