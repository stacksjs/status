import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth, generateTwoFactorToken, getTwoFactorState } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import User from '../../app/Models/User'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id / email namespace.
const TEAM_ID = 90007
const OWNER_EMAIL = 'security-owner-90007@example.com'
const OTHER_EMAIL = 'security-other-90007@example.com'
const PASSWORD = 'a-real-password-1'

describe('Security settings backend (stacksjs/status#1 Phase 9 follow-up)', () => {
  let ownerId: number
  let otherId: number
  let ownerToken: string
  let otherToken: string

  beforeAll(async () => {
    // Created through the model so the set.password mutator bcrypt-hashes
    // it — DisableTwoFactorAction and /api/login re-verify the password
    // via Auth.validate, which a raw-insert placeholder can never pass.
    const owner = await User.create({ name: 'Security Owner', email: OWNER_EMAIL, password: PASSWORD })
    const other = await User.create({ name: 'Security Other', email: OTHER_EMAIL, password: PASSWORD })
    ownerId = owner.id
    otherId = other.id

    await db.insertInto('teams').values({ id: TEAM_ID, name: 'Security test team' }).execute()
    await db.insertInto('team_members').values({ team_id: TEAM_ID, user_id: ownerId, role: 'owner', status: 'active', invited_email: OWNER_EMAIL }).execute()

    ownerToken = String((await Auth.loginUsingId(ownerId, { withRefreshToken: false }))!.token)
    otherToken = String((await Auth.loginUsingId(otherId, { withRefreshToken: false }))!.token)
  })

  afterAll(async () => {
    for (const userId of [ownerId, otherId]) {
      await db.deleteFrom('oauth_access_tokens').where('user_id', '=', userId).execute()
      await db.deleteFrom('two_factor_pending_secrets').where('user_id', '=', userId).execute()
      await db.deleteFrom('two_factor_challenges').where('user_id', '=', userId).execute()
      await db.deleteFrom('passkeys').where('user_id', '=', userId).execute()
      await db.deleteFrom('users').where('id', '=', userId).execute()
    }
    await db.deleteFrom('team_members').where('team_id', '=', TEAM_ID).execute()
    await db.deleteFrom('teams').where('id', '=', TEAM_ID).execute()
  })

  const authed = (token: string) => featureTest().withHeaders({ Authorization: `Bearer ${token}` })
  // Anonymous POSTs (login, 2FA verify) must satisfy the CSRF double-submit
  // check the router injects on every mutation — bearer callers bypass it.
  const anonPost = () => featureTest().withHeaders({ 'x-csrf-token': 'sec-test-csrf-90007', 'cookie': 'X-CSRF-Token=sec-test-csrf-90007' })

  test('the 2FA setup endpoint rejects anonymous callers', async () => {
    const res = await featureTest().post('/generate-two-factor-secret', {})
    expect(res.status).toBe(401)
  })

  // Regression test for the app Auth middleware not stamping
  // request._authenticatedUser: every framework 2FA action reads
  // `await request.user()` and 401'd on valid bearers before the fix.
  test('a valid bearer reaches the framework 2FA actions as an authenticated user', async () => {
    const res = await authed(ownerToken).post('/generate-two-factor-secret', {})
    expect(res.status).toBe(200)

    const body = await res.json<{ secret: string, uri: string }>()
    expect(body.secret).toBeTruthy()
    expect(body.uri).toContain('otpauth://totp/')
  })

  test('the dashboard form flow enables, challenges at login, and disables TOTP', async () => {
    // Fresh setup through the JSON endpoint (same stash the security.stx
    // ?setup=1 step writes) — the form action must consume it.
    const setup = await authed(ownerToken).post('/generate-two-factor-secret', {})
    const { secret } = await setup.json<{ secret: string }>()

    const code = await generateTwoFactorToken(secret)
    const enable = await authed(ownerToken).post('/api/security-forms/two-factor/enable', { code })
    expect(enable.status).toBe(302)
    expect(enable.headers.get('Location')).toBe('/dashboard/settings/security?twofa=enabled')
    expect((await getTwoFactorState(ownerId)).enabled).toBe(true)

    // Password login now returns a 2FA challenge instead of tokens...
    const login = await anonPost().post('/api/login', { email: OWNER_EMAIL, password: PASSWORD })
    expect(login.status).toBe(200)
    const challenge = await login.json<{ requires_two_factor?: boolean, challenge_token?: string, token?: string }>()
    expect(challenge.requires_two_factor).toBe(true)
    expect(challenge.challenge_token).toBeTruthy()
    expect(challenge.token).toBeFalsy()

    // ...and the challenge + a fresh code completes it with a token pack.
    const verify = await anonPost().post('/api/verify-two-factor-login', {
      challenge_token: challenge.challenge_token,
      code: await generateTwoFactorToken(secret),
    })
    expect(verify.status).toBe(200)
    const verified = await verify.json<{ token?: string, user?: { id: number } }>()
    expect(verified.token).toBeTruthy()
    expect(verified.user?.id).toBe(ownerId)
    await db.deleteFrom('oauth_access_tokens').where('token', '=', String(verified.token).split('|').pop()).execute().catch(() => {})

    // Wrong password cannot disable it.
    const badDisable = await authed(ownerToken).post('/api/security-forms/two-factor/disable', { password: 'not-the-password' })
    expect(badDisable.status).toBe(302)
    expect(badDisable.headers.get('Location')).toBe('/dashboard/settings/security?error=bad_password')
    expect((await getTwoFactorState(ownerId)).enabled).toBe(true)

    // The real password can.
    const disable = await authed(ownerToken).post('/api/security-forms/two-factor/disable', { password: PASSWORD })
    expect(disable.status).toBe(302)
    expect(disable.headers.get('Location')).toBe('/dashboard/settings/security?twofa=disabled')
    expect((await getTwoFactorState(ownerId)).enabled).toBe(false)
  })

  test('an expired or missing setup stash redirects with setup_expired instead of enabling', async () => {
    await db.deleteFrom('two_factor_pending_secrets').where('user_id', '=', ownerId).execute()
    const res = await authed(ownerToken).post('/api/security-forms/two-factor/enable', { code: '123456' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/dashboard/settings/security?error=setup_expired')
    expect((await getTwoFactorState(ownerId)).enabled).toBe(false)
  })

  test('passkey deletion is scoped to the credential owner', async () => {
    await db.insertInto('passkeys').values({
      id: 'security-test-cred-90007',
      cred_public_key: 'test-public-key',
      user_id: ownerId,
      webauthn_user_id: OWNER_EMAIL,
      counter: 0,
    }).execute()

    // Another signed-in user cannot remove it by guessing the id.
    const foreign = await authed(otherToken).post('/api/security-forms/passkeys/delete', { id: 'security-test-cred-90007' })
    expect(foreign.status).toBe(302)
    let rows = await db.selectFrom('passkeys').where('id', '=', 'security-test-cred-90007').execute()
    expect(rows.length).toBe(1)

    // The owner can.
    const own = await authed(ownerToken).post('/api/security-forms/passkeys/delete', { id: 'security-test-cred-90007' })
    expect(own.status).toBe(302)
    expect(own.headers.get('Location')).toBe('/dashboard/settings/security?passkey=removed')
    rows = await db.selectFrom('passkeys').where('id', '=', 'security-test-cred-90007').execute()
    expect(rows.length).toBe(0)
  })

  test('the security form actions reject anonymous callers', async () => {
    for (const path of ['/api/security-forms/two-factor/enable', '/api/security-forms/two-factor/disable', '/api/security-forms/passkeys/delete']) {
      const res = await featureTest().withHeaders({ 'x-csrf-token': 'test', 'cookie': 'X-CSRF-Token=test' }).post(path, { code: '123456', password: 'x', id: 'nope' })
      expect(res.status).toBe(401)
    }
  })
})
