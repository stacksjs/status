import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { db } from '@stacksjs/database'

// Social login/signup via @stacksjs/socials (Google, Apple, GitHub) —
// both legs of the flow through the real in-process router pipeline
// (routes/api.ts → SsoRedirectAction/SsoCallbackAction), with only the
// PROVIDERS' HTTP endpoints mocked (globalThis.fetch). Everything else —
// state cookie, code exchange, account provisioning, SsoIdentity
// linking, session cookie — is the production code path.
//
// The fake provider credentials live in tests/setup.ts — they must be
// in place before any @stacksjs/* module evaluates the config, which
// the import of @stacksjs/database below already triggers.

// Distinct email namespace so concurrent test files don't collide.
const GH_EMAIL = 'sso-social-gh-77821@example.com'
const APPLE_EMAIL = 'sso-social-apple-77822@privaterelay.appleid.com'

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Decode the (signed but not encrypted) sso-flow cookie payload. */
function decodeFlowCookie(setCookie: string): { state: string, nonce: string, provider: string } {
  const value = setCookie.split(';')[0]!.split('=')[1]!
  const payload = value.split('.')[0]!
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
}

function cookiePair(setCookie: string): string {
  return setCookie.split(';')[0]!
}

async function serverHandle(url: string, init: RequestInit = {}): Promise<Response> {
  const router = await import('@stacksjs/router')
  // A hand-built Request carries no Host header, which would make
  // requestOrigin() fall back to APP_URL — pin it to the test origin.
  const headers = new Headers(init.headers)
  headers.set('Host', 'localhost')
  return (router.serverResponse as unknown as (req: Request) => Promise<Response>)(
    new Request(url, { ...init, headers }),
  )
}

// ---------------------------------------------------------------------
// Provider HTTP mock: intercept only the provider hosts, pass every
// other request through (nothing else should leave the process, but
// being surgical keeps failures honest).
// ---------------------------------------------------------------------
const realFetch = globalThis.fetch
type MockRoute = (url: string, init?: RequestInit) => Response | null
let mockRoutes: MockRoute[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    for (const route of mockRoutes) {
      const res = route(url, init)
      if (res)
        return res
    }
    return realFetch(input as any, init)
  }) as typeof fetch
})

afterAll(async () => {
  globalThis.fetch = realFetch

  for (const email of [GH_EMAIL, APPLE_EMAIL]) {
    const user = await db.selectFrom('users').where('email', '=', email).select(['id']).executeTakeFirst()
    if (user) {
      const userId = Number(user.id)
      await db.deleteFrom('sso_identities').where('user_id', '=', userId).execute()
      await db.deleteFrom('oauth_access_tokens').where('user_id', '=', userId).execute()
      const teams = await db.selectFrom('teams').where('user_id', '=', userId).select(['id']).execute()
      await db.deleteFrom('team_members').where('user_id', '=', userId).execute()
      for (const team of teams)
        await db.deleteFrom('teams').where('id', '=', Number(team.id)).execute()
      await db.deleteFrom('users').where('id', '=', userId).execute()
    }
  }
})

describe('SSO redirect leg (social providers)', () => {
  test('GitHub: 302 to github.com with client_id, per-request redirect_uri, state + flow cookie', async () => {
    const res = await serverHandle('http://localhost/api/auth/sso/github')
    expect(res.status).toBe(302)

    const location = new URL(res.headers.get('Location')!)
    expect(location.origin).toBe('https://github.com')
    expect(location.pathname).toBe('/login/oauth/authorize')
    expect(location.searchParams.get('client_id')).toBe('test-github-id')
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/sso/github/callback')

    const setCookie = res.headers.get('Set-Cookie')!
    expect(setCookie).toContain('sso-flow=')
    const flow = decodeFlowCookie(setCookie)
    expect(flow.provider).toBe('github')
    expect(location.searchParams.get('state')).toBe(flow.state)
  })

  test('Google: 302 to accounts.google.com with openid scope', async () => {
    const res = await serverHandle('http://localhost/api/auth/sso/google')
    expect(res.status).toBe(302)

    const location = new URL(res.headers.get('Location')!)
    expect(location.origin).toBe('https://accounts.google.com')
    expect(location.searchParams.get('client_id')).toBe('test-google-id')
    expect(location.searchParams.get('scope')).toContain('openid')
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/sso/google/callback')
  })

  test('Apple: 302 to appleid.apple.com with form_post, nonce, and a cross-site-capable cookie', async () => {
    const res = await serverHandle('http://localhost/api/auth/sso/apple')
    expect(res.status).toBe(302)

    const location = new URL(res.headers.get('Location')!)
    expect(location.origin).toBe('https://appleid.apple.com')
    expect(location.pathname).toBe('/auth/authorize')
    expect(location.searchParams.get('response_mode')).toBe('form_post')
    expect(location.searchParams.get('scope')).toBe('name email')

    const setCookie = res.headers.get('Set-Cookie')!
    // form_post arrives cross-site — Lax would never send the cookie back.
    expect(setCookie).toContain('SameSite=None')
    const flow = decodeFlowCookie(setCookie)
    expect(location.searchParams.get('nonce')).toBe(flow.nonce)
  })

  test('unknown provider bounces to /login with an error', async () => {
    const res = await serverHandle('http://localhost/api/auth/sso/myspace')
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login?error=sso_unknown_provider')
  })
})

describe('SSO callback leg — GitHub', () => {
  async function startFlow(): Promise<{ state: string, cookie: string }> {
    const res = await serverHandle('http://localhost/api/auth/sso/github')
    const setCookie = res.headers.get('Set-Cookie')!
    return { state: decodeFlowCookie(setCookie).state, cookie: cookiePair(setCookie) }
  }

  function mockGitHub(): void {
    mockRoutes = [
      (url) => {
        if (url.startsWith('https://github.com/login/oauth/access_token'))
          return jsonResponse({ access_token: 'gh-test-token' })
        if (url.startsWith('https://api.github.com/user/emails'))
          return jsonResponse([{ email: GH_EMAIL, primary: true, verified: true }])
        if (url.startsWith('https://api.github.com/user'))
          return jsonResponse({ id: 990011, login: 'octo-tester', name: 'Octo Tester', avatar_url: null, email: null })
        return null
      },
    ]
  }

  test('signs up a brand-new user, links the identity, and mints a session', async () => {
    mockGitHub()
    const { state, cookie } = await startFlow()

    const res = await serverHandle(
      `http://localhost/api/auth/sso/github/callback?code=test-code&state=${state}`,
      { headers: { Cookie: cookie } },
    )

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/dashboard/monitors')

    // Session cookie minted + flow cookie cleared.
    const cookies = res.headers.getSetCookie()
    expect(cookies.some(c => c.startsWith('sso-flow=;'))).toBe(true)
    expect(cookies.some(c => !c.startsWith('sso-flow=') && c.includes('HttpOnly'))).toBe(true)

    // User provisioned with the GitHub profile, identity linked by subject.
    const user = await db.selectFrom('users').where('email', '=', GH_EMAIL).select(['id', 'name']).executeTakeFirst()
    expect(user).toBeTruthy()
    expect(user!.name).toBe('Octo Tester')

    const identity = await db.selectFrom('sso_identities')
      .where('provider', '=', 'github')
      .where('subject', '=', '990011')
      .select(['user_id'])
      .executeTakeFirst()
    expect(identity).toBeTruthy()
    expect(Number(identity!.user_id)).toBe(Number(user!.id))

    // The new user owns a team, like RegisterAction gives password signups.
    const membership = await db.selectFrom('team_members').where('user_id', '=', Number(user!.id)).select(['role']).executeTakeFirst()
    expect(membership?.role).toBe('owner')
  })

  test('logging in again with the same identity reuses the account', async () => {
    mockGitHub()
    const { state, cookie } = await startFlow()

    const res = await serverHandle(
      `http://localhost/api/auth/sso/github/callback?code=test-code-2&state=${state}`,
      { headers: { Cookie: cookie } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/dashboard/monitors')

    const users = await db.selectFrom('users').where('email', '=', GH_EMAIL).select(['id']).execute()
    expect(users.length).toBe(1)
    const identities = await db.selectFrom('sso_identities').where('provider', '=', 'github').where('subject', '=', '990011').select(['id']).execute()
    expect(identities.length).toBe(1)
  })

  test('rejects a forged state (CSRF)', async () => {
    mockGitHub()
    const { cookie } = await startFlow()

    const res = await serverHandle(
      'http://localhost/api/auth/sso/github/callback?code=test-code&state=forged-state',
      { headers: { Cookie: cookie } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login?error=sso_state_mismatch')
  })

  test('rejects a missing flow cookie', async () => {
    mockGitHub()
    const { state } = await startFlow()

    const res = await serverHandle(
      `http://localhost/api/auth/sso/github/callback?code=test-code&state=${state}`,
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login?error=sso_state_mismatch')
  })
})

describe('SSO callback leg — Apple (form_post)', () => {
  test('accepts the cross-site POST, validates the nonce, and provisions with the form-post name', async () => {
    const redirect = await serverHandle('http://localhost/api/auth/sso/apple')
    const setCookie = redirect.headers.get('Set-Cookie')!
    const flow = decodeFlowCookie(setCookie)

    const idToken = `${b64url({ alg: 'RS256', kid: 'apple-kid' })}.${b64url({
      iss: 'https://appleid.apple.com',
      aud: 'org.uptime-status.test',
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      sub: 'apple-subject-778',
      email: APPLE_EMAIL,
      email_verified: 'true',
      nonce: flow.nonce,
    })}.${Buffer.from('sig').toString('base64url')}`

    mockRoutes = [
      (url) => {
        if (url.startsWith('https://appleid.apple.com/auth/token'))
          return jsonResponse({ access_token: 'apple-at', token_type: 'Bearer', expires_in: 3600, id_token: idToken })
        return null
      },
    ]

    const body = new URLSearchParams({
      code: 'apple-code',
      state: flow.state,
      // Apple sends the name exactly once, on first authorization.
      user: JSON.stringify({ name: { firstName: 'Tim', lastName: 'Apfel' }, email: APPLE_EMAIL }),
    })

    const res = await serverHandle('http://localhost/api/auth/sso/apple/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookiePair(setCookie),
      },
      body: body.toString(),
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/dashboard/monitors')

    const user = await db.selectFrom('users').where('email', '=', APPLE_EMAIL).select(['id', 'name']).executeTakeFirst()
    expect(user).toBeTruthy()
    expect(user!.name).toBe('Tim Apfel')

    const identity = await db.selectFrom('sso_identities')
      .where('provider', '=', 'apple')
      .where('subject', '=', 'apple-subject-778')
      .select(['user_id'])
      .executeTakeFirst()
    expect(identity).toBeTruthy()
  })

  test('rejects an id_token whose nonce does not match the flow', async () => {
    const redirect = await serverHandle('http://localhost/api/auth/sso/apple')
    const setCookie = redirect.headers.get('Set-Cookie')!
    const flow = decodeFlowCookie(setCookie)

    const idToken = `${b64url({ alg: 'RS256' })}.${b64url({
      iss: 'https://appleid.apple.com',
      aud: 'org.uptime-status.test',
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: Math.floor(Date.now() / 1000),
      sub: 'apple-subject-999',
      email: 'replay@privaterelay.appleid.com',
      nonce: 'a-different-nonce',
    })}.${Buffer.from('sig').toString('base64url')}`

    mockRoutes = [
      (url) => {
        if (url.startsWith('https://appleid.apple.com/auth/token'))
          return jsonResponse({ access_token: 'apple-at', token_type: 'Bearer', expires_in: 3600, id_token: idToken })
        return null
      },
    ]

    const res = await serverHandle('http://localhost/api/auth/sso/apple/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': cookiePair(setCookie),
      },
      body: new URLSearchParams({ code: 'apple-code', state: flow.state }).toString(),
    })

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/login?error=sso_bad_id_token')
  })
})
