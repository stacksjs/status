import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { awaitConfig } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import DashboardUpdateTeamMemberRoleAction from '../../app/Actions/Teams/DashboardUpdateTeamMemberRoleAction'
import TeamMember from '../../app/Models/TeamMember'

/**
 * The roster rendered `role` as plain text, so promoting or demoting anyone
 * meant removing them and sending a fresh invite — revoking an active
 * member's access to change one word.
 *
 * The interesting part is not the update, it is the last-owner guard: roles
 * are the only thing between a team and nobody who can administer it, and a
 * team that demotes its way out of having an owner cannot climb back in from
 * inside the product.
 */
const SEED = 90077

describe('team member roles', () => {
  let teamId: number
  let otherTeamId: number
  let token: string

  async function member(email: string, role: string, team = teamId) {
    await db.insertInto('team_members').values({ team_id: team, user_id: null, role, status: 'active', invited_email: email }).execute()
    return (await db.selectFrom('team_members').where('invited_email', '=', email).select(['id']).executeTakeFirst())!
  }

  function fakeRequest(fields: Record<string, string | undefined>) {
    return { get: (k: string) => fields[k], bearerToken: () => token, cookies: { get: () => undefined } } as any
  }

  const roleOf = async (id: number) =>
    (await db.selectFrom('team_members').where('id', '=', id).select(['role']).executeTakeFirst())?.role

  beforeAll(async () => {
    await awaitConfig()
    for (const name of [`Roles Team ${SEED}`, `Roles Other ${SEED}`])
      await db.deleteFrom('teams').where('name', '=', name).execute()
    await db.deleteFrom('users').where('email', '=', `roles-owner-${SEED}@example.com`).execute()

    await db.insertInto('teams').values({ name: `Roles Team ${SEED}` }).execute()
    teamId = Number((await db.selectFrom('teams').where('name', '=', `Roles Team ${SEED}`).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('teams').values({ name: `Roles Other ${SEED}` }).execute()
    otherTeamId = Number((await db.selectFrom('teams').where('name', '=', `Roles Other ${SEED}`).select(['id']).executeTakeFirst())!.id)

    await db.insertInto('users').values({ name: 'Roles Owner', email: `roles-owner-${SEED}@example.com`, password: 'x'.repeat(10) }).execute()
    const userId = Number((await db.selectFrom('users').where('email', '=', `roles-owner-${SEED}@example.com`).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('team_members').values({ team_id: teamId, user_id: userId, role: 'owner', status: 'active', invited_email: `roles-owner-${SEED}@example.com` }).execute()
    token = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)
  })

  afterAll(async () => {
    for (const id of [teamId, otherTeamId]) {
      await db.deleteFrom('team_members').where('team_id', '=', id).execute()
      await db.deleteFrom('teams').where('id', '=', id).execute()
    }
    await db.deleteFrom('users').where('email', '=', `roles-owner-${SEED}@example.com`).execute()
  })

  test('promotes a member to admin', async () => {
    const row = await member(`promote-${SEED}@example.com`, 'member')

    const res = await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(row.id), role: 'admin' }))

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('saved=1')
    expect(await roleOf(Number(row.id))).toBe('admin')
  })

  test('demotes an admin back to member', async () => {
    const row = await member(`demote-${SEED}@example.com`, 'admin')
    await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(row.id), role: 'member' }))
    expect(await roleOf(Number(row.id))).toBe('member')
  })

  test('refuses to demote the last owner', async () => {
    // The seeded owner is the only one. Letting this through would leave the
    // team with nobody who can invite, remove, or promote — unrecoverable
    // from inside the dashboard.
    const owner = (await db.selectFrom('team_members').where('team_id', '=', teamId).where('role', '=', 'owner').select(['id']).executeTakeFirst())!

    const res = await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(owner.id), role: 'member' }))

    expect(res.headers.get('location')).toContain('error=last_owner')
    expect(await roleOf(Number(owner.id))).toBe('owner')
  })

  test('allows demoting an owner once a second owner exists', async () => {
    const second = await member(`co-owner-${SEED}@example.com`, 'owner')

    await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(second.id), role: 'member' }))

    expect(await roleOf(Number(second.id))).toBe('member')
    // ...and the guard is armed again now that we are back to one.
    const owner = (await db.selectFrom('team_members').where('team_id', '=', teamId).where('role', '=', 'owner').select(['id']).executeTakeFirst())!
    const res = await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(owner.id), role: 'admin' }))
    expect(res.headers.get('location')).toContain('error=last_owner')
  })

  test('rejects a role that is not on the list', async () => {
    const row = await member(`badrole-${SEED}@example.com`, 'member')

    const res = await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(row.id), role: 'superadmin' }))

    expect(res.headers.get('location')).toContain('error=bad_role')
    expect(await roleOf(Number(row.id))).toBe('member')
  })

  test('another team\'s member is refused, not silently edited', async () => {
    const foreign = await member(`foreign-${SEED}@example.com`, 'member', otherTeamId)

    const res = await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(foreign.id), role: 'owner' }))

    expect(res.status).toBe(403)
    expect(await roleOf(Number(foreign.id))).toBe('member')
  })

  test('a no-op re-save is accepted without touching the row', async () => {
    const row = await member(`noop-${SEED}@example.com`, 'admin')

    const res = await DashboardUpdateTeamMemberRoleAction.handle(fakeRequest({ id: String(row.id), role: 'admin' }))

    expect(res.status).toBe(302)
    expect(await roleOf(Number(row.id))).toBe('admin')
  })

  test('no session is a 401', async () => {
    const anon = { get: () => undefined, bearerToken: () => undefined, cookies: { get: () => undefined } } as any
    const res = await DashboardUpdateTeamMemberRoleAction.handle(anon)
    expect(res.status).toBe(401)
  })
})
