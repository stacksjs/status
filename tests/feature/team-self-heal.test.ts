import { afterEach, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { createPersonalTeam, resolveOrCreateTeamId } from '../../app/lib/teamContext'

/**
 * A signed-in user with no team could do nothing at all, forever.
 *
 * Every dashboard action is team-scoped and 401'd when team resolution came
 * back null — which happens both when there is no session AND when a valid
 * session belongs to no team. RegisterAction creates a personal team at
 * signup, but inside a best-effort try/catch, and when that attempt fails
 * there was no second chance: no "create a team" screen exists, so the
 * account could sign in, load the dashboard, read empty lists, and mutate
 * nothing. It reported "Authentication required" the whole time.
 *
 * This was reproduced against a freshly registered account on production
 * while the identical path succeeded locally, so the trigger is
 * environmental. These tests cover the recovery rather than the trigger:
 * whatever went wrong at signup, the next action repairs it.
 */
const SEED = 90055

describe('team self-heal', () => {
  const emails: string[] = []

  async function makeUser(name: string): Promise<{ id: number, email: string, token: string }> {
    const email = `team-heal-${SEED}-${name}@example.com`
    emails.push(email)
    await db.deleteFrom('users').where('email', '=', email).execute()
    await db.insertInto('users').values({ name, email, password: 'x'.repeat(10) }).execute()
    const row = await db.selectFrom('users').where('email', '=', email).select(['id']).executeTakeFirst()
    const id = Number(row!.id)
    const token = await Auth.createToken({ id } as never)
    return { id, email, token }
  }

  /** The request shape the resolvers read, matching app/lib/authRequest. */
  function fakeRequest(token?: string) {
    return { bearerToken: () => token, cookies: { get: () => null } }
  }

  afterEach(async () => {
    for (const email of emails) {
      const row = await db.selectFrom('users').where('email', '=', email).select(['id']).executeTakeFirst()
      if (row?.id) {
        const memberships = await db.selectFrom('team_members').where('user_id', '=', Number(row.id)).select(['team_id']).execute()
        for (const m of memberships)
          await db.deleteFrom('teams').where('id', '=', Number(m.team_id)).execute()
        await db.deleteFrom('team_members').where('user_id', '=', Number(row.id)).execute()
      }
      await db.deleteFrom('users').where('email', '=', email).execute()
    }
    emails.length = 0
  })

  test('a signed-in user with no team gets one instead of a 401', async () => {
    const user = await makeUser('orphan')

    // Precondition: this is exactly the state a failed signup leaves behind.
    const before = await db.selectFrom('team_members').where('user_id', '=', user.id).select(['team_id']).execute()
    expect(before).toHaveLength(0)

    const teamId = await resolveOrCreateTeamId(fakeRequest(user.token))

    expect(typeof teamId).toBe('number')
    expect(teamId).toBeGreaterThan(0)
  })

  test('the healed team is owned by that user and resolvable', async () => {
    const user = await makeUser('owner')
    const teamId = await resolveOrCreateTeamId(fakeRequest(user.token))

    const membership = await db.selectFrom('team_members')
      .where('user_id', '=', user.id)
      .select(['team_id', 'role', 'status'])
      .executeTakeFirst()

    expect(Number(membership!.team_id)).toBe(teamId!)
    expect(membership!.role).toBe('owner')
    // resolveTeamContext filters on status = 'active'; anything else and the
    // team exists but still does not resolve, which is the original bug with
    // extra steps.
    expect(membership!.status).toBe('active')
  })

  test('it is idempotent — a second call reuses the team, never stacks them', async () => {
    const user = await makeUser('idempotent')

    const first = await resolveOrCreateTeamId(fakeRequest(user.token))
    const second = await resolveOrCreateTeamId(fakeRequest(user.token))

    expect(second).toBe(first!)

    const memberships = await db.selectFrom('team_members').where('user_id', '=', user.id).select(['id']).execute()
    expect(memberships).toHaveLength(1)
  })

  test('no session still resolves to null, so callers can 401 honestly', async () => {
    // The distinction that was missing: null now means "not signed in" only.
    expect(await resolveOrCreateTeamId(fakeRequest(undefined))).toBeNull()
    expect(await resolveOrCreateTeamId(fakeRequest('not-a-real-token'))).toBeNull()
  })

  test('the guard answers 401 for no session and passes a team through otherwise', async () => {
    const { requireTeamId } = await import('../../app/lib/teamGuard')

    const anonymous = await requireTeamId(fakeRequest(undefined))
    expect(anonymous).toBeInstanceOf(Response)
    expect((anonymous as Response).status).toBe(401)

    // A signed-in user with no team must NOT get a 401 — that is the message
    // that sent a logged-in operator back to the login page on every write.
    const user = await makeUser('guard')
    const healed = await requireTeamId(fakeRequest(user.token))
    expect(typeof healed).toBe('number')
  })

  test('createPersonalTeam names the team after the user, or falls back', async () => {
    const named = await makeUser('named')
    const teamId = await createPersonalTeam(named.id, 'Ada', named.email)
    const team = await db.selectFrom('teams').where('id', '=', teamId!).select(['name']).executeTakeFirst()
    expect(team!.name).toBe(`Ada's Team`)

    const anon = await makeUser('anon')
    const anonTeamId = await createPersonalTeam(anon.id, '   ', anon.email)
    const anonTeam = await db.selectFrom('teams').where('id', '=', anonTeamId!).select(['name']).executeTakeFirst()
    expect(anonTeam!.name).toBe('My Team')
  })
})
