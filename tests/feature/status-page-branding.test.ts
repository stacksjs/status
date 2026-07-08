import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import UpdateStatusPageAction from '../../app/Actions/StatusPages/UpdateStatusPageAction'
import StatusPage from '../../app/Models/StatusPage'

// Distinct high seed — see monitor-crud.test.ts for why each file owns its team.
const SEED = 90012
const OWNER_EMAIL = `sp-branding-owner-${SEED}@example.com`

describe('Status page branding (stacksjs/status#1)', () => {
  let teamId: number
  let userId: number
  let token: string
  let page: any

  // Mirrors monitor-crud.test.ts's fakeRequest: get() for form fields,
  // bearerToken() for the credential UpdateStatusPageAction authenticates with.
  function fakeRequest(fields: Record<string, string | undefined>, tok?: string) {
    return {
      get: (key: string) => fields[key],
      bearerToken: () => tok,
      cookies: { get: () => undefined },
    } as any
  }

  beforeAll(async () => {
    await db.insertInto('teams').values({ name: `SP Branding Team ${SEED}` }).execute()
    teamId = Number((await db.selectFrom('teams').where('name', '=', `SP Branding Team ${SEED}`).select(['id']).executeTakeFirst())!.id)

    await db.insertInto('users').values({ name: 'SP Branding Owner', email: OWNER_EMAIL, password: 'x'.repeat(10) }).execute()
    userId = Number((await db.selectFrom('users').where('email', '=', OWNER_EMAIL).select(['id']).executeTakeFirst())!.id)

    await db.insertInto('team_members').values({ team_id: teamId, user_id: userId, role: 'owner', status: 'active', invited_email: OWNER_EMAIL }).execute()

    token = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)

    page = await StatusPage.create({ team_id: teamId, title: 'Branding page', slug: `sp-branding-${SEED}`, is_public: true })
  })

  afterAll(async () => {
    if (page) {
      const row = await StatusPage.find(page.id)
      if (row) await row.delete()
    }
    await db.deleteFrom('team_members').where('user_id', '=', userId).execute()
    await db.deleteFrom('users').where('id', '=', userId).execute()
    await db.deleteFrom('teams').where('id', '=', teamId).execute()
  })

  test('the update action assembles logo + accent into the branding JSON blob', async () => {
    const res = await UpdateStatusPageAction.handle(fakeRequest({
      id: String(page.id),
      title: 'Branding page',
      logo_url: 'https://acme.example/logo.svg',
      primary_color: '#2563eb',
    }, token))
    expect(res.status).toBe(302)

    const reloaded = await StatusPage.find(page.id)
    expect(JSON.parse(reloaded!.branding)).toEqual({ logoUrl: 'https://acme.example/logo.svg', primaryColor: '#2563eb' })
  })

  test('an update that omits the branding fields leaves branding untouched', async () => {
    // Preconditon: branding set by the previous test.
    const res = await UpdateStatusPageAction.handle(fakeRequest({
      id: String(page.id),
      title: 'Renamed page',
    }, token))
    expect(res.status).toBe(302)

    const reloaded = await StatusPage.find(page.id)
    expect(reloaded!.title).toBe('Renamed page')
    expect(JSON.parse(reloaded!.branding)).toEqual({ logoUrl: 'https://acme.example/logo.svg', primaryColor: '#2563eb' })
  })

  test('blank fields clear the logo and accent', async () => {
    const res = await UpdateStatusPageAction.handle(fakeRequest({
      id: String(page.id),
      logo_url: '',
      primary_color: '',
    }, token))
    expect(res.status).toBe(302)

    const reloaded = await StatusPage.find(page.id)
    expect(JSON.parse(reloaded!.branding)).toEqual({ logoUrl: '', primaryColor: '' })
  })

  test("another team's owner cannot edit this page's branding", async () => {
    const otherEmail = `sp-branding-intruder-${SEED}@example.com`
    await db.insertInto('teams').values({ name: `SP Branding Intruder ${SEED}` }).execute()
    const otherTeamId = Number((await db.selectFrom('teams').where('name', '=', `SP Branding Intruder ${SEED}`).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('users').values({ name: 'Intruder', email: otherEmail, password: 'x'.repeat(10) }).execute()
    const otherUserId = Number((await db.selectFrom('users').where('email', '=', otherEmail).select(['id']).executeTakeFirst())!.id)
    await db.insertInto('team_members').values({ team_id: otherTeamId, user_id: otherUserId, role: 'owner', status: 'active', invited_email: otherEmail }).execute()
    const otherToken = String((await Auth.loginUsingId(otherUserId, { withRefreshToken: false }))!.token)

    try {
      const res = await UpdateStatusPageAction.handle(fakeRequest({
        id: String(page.id),
        logo_url: 'https://evil.example/logo.svg',
        primary_color: '#000000',
      }, otherToken))
      expect(res.status).toBe(404)

      // Branding is unchanged from the previous (cleared) state.
      const reloaded = await StatusPage.find(page.id)
      expect(JSON.parse(reloaded!.branding)).toEqual({ logoUrl: '', primaryColor: '' })
    }
    finally {
      await db.deleteFrom('team_members').where('user_id', '=', otherUserId).execute()
      await db.deleteFrom('users').where('id', '=', otherUserId).execute()
      await db.deleteFrom('teams').where('id', '=', otherTeamId).execute()
    }
  })
})
