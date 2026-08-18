import { afterAll, describe, expect, test } from 'bun:test'
import { Auth, resolveTeamContext } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { authRequest } from '../../app/lib/authRequest'

/**
 * Token -> user -> team, through the exact object a dashboard page builds.
 *
 * The gap this fills: a whole-dashboard auth failure shipped and no test
 * noticed, because every existing test either calls an Action with a
 * hand-made request or asserts on the database. Nothing exercised the path a
 * rendered page takes, so "pages cannot read the session cookie" was
 * invisible to CI while being total in the browser.
 */

// Unique per run: a failed run leaves rows behind, and a fixed email then
// collides on the users table's unique index rather than failing on the thing
// under test.
const SEED = Math.floor(performance.now() * 1000)
const created: { users: number[], teams: number[] } = { users: [], teams: [] }

/** Same construction the other dashboard feature tests use. */
async function makeUser(email: string, teamName: string): Promise<{ userId: number, teamId: number, token: string }> {
  await db.insertInto('teams').values({ name: teamName } as never).execute()
  const teamId = Number((await db.selectFrom('teams').where('name', '=', teamName).select(['id']).executeTakeFirst())!.id)
  created.teams.push(teamId)

  await db.insertInto('users').values({ name: 'Session Test', email, password: 'x'.repeat(10) } as never).execute()
  const userId = Number((await db.selectFrom('users').where('email', '=', email).select(['id']).executeTakeFirst())!.id)
  created.users.push(userId)

  await db.insertInto('team_members').values({
    team_id: teamId,
    user_id: userId,
    role: 'owner',
    status: 'active',
    invited_email: email,
  } as never).execute()

  const token = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)

  return { userId, teamId, token }
}

describe('a dashboard page resolving its session', () => {
  afterAll(async () => {
    for (const id of created.users) {
      await db.deleteFrom('team_members').where('user_id', '=', id).execute().catch(() => {})
      await db.deleteFrom('users').where('id', '=', id).execute().catch(() => {})
    }
    for (const id of created.teams)
      await db.deleteFrom('teams').where('id', '=', id).execute().catch(() => {})
  })

  test('the cookie stx hands the page resolves to its user and team', async () => {
    const { userId, teamId, token } = await makeUser(`session-${SEED}-a@example.com`, `Session Team ${SEED}a`)

    const context = await resolveTeamContext(authRequest({ 'auth-token': token }))

    expect(context.user?.id).toBe(userId)
    expect(context.teamId).toBe(teamId)
    expect(context.teams.map(t => Number(t.id))).toContain(teamId)
  })

  test('no cookie is a guest, not an error', async () => {
    // Pages render a signed-out state from this; it must never throw, or
    // every logged-out visitor gets a 500 instead of a sign-in prompt.
    const context = await resolveTeamContext(authRequest(null))

    expect(context.user).toBeNull()
    expect(context.teamId).toBeNull()
    expect(context.teams).toEqual([])
  })

  test('a token that is not a token is a guest, not an error', async () => {
    const context = await resolveTeamContext(authRequest({ 'auth-token': 'not-a-real-token' }))

    expect(context.user).toBeNull()
    expect(context.teamId).toBeNull()
  })

  test('a member of one team does not resolve into another', async () => {
    // The isolation the whole dashboard's team scoping rests on: every page
    // filters by TEAM_ID from this context.
    const first = await makeUser(`session-${SEED}-b@example.com`, `Session Team ${SEED}b`)
    const second = await makeUser(`session-${SEED}-c@example.com`, `Session Team ${SEED}c`)

    const context = await resolveTeamContext(authRequest({ 'auth-token': second.token }))

    expect(context.teamId).toBe(second.teamId)
    expect(context.teams.map(t => Number(t.id))).not.toContain(first.teamId)
  })
})
