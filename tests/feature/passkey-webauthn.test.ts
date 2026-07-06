import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import { bytesToBase64url } from '../../app/Actions/Security/webauthn'
import User from '../../app/Models/User'

// WebAuthn relying-party identity the actions read via relyingParty().
process.env.WEBAUTHN_RP_ID = 'localhost'
process.env.WEBAUTHN_ORIGIN = 'http://localhost'
const RP_ID = 'localhost'
const ORIGIN = 'http://localhost'

// The browser layer (navigator.credentials) is proven separately against a
// real Chrome virtual authenticator; this suite drives the real routes,
// actions, db, cookie handling, and crypto with a synthesized-but-valid
// ECDSA assertion — no browser needed.
const TEAM_ID = 90008
const EMAIL = 'passkey-user-90008@example.com'
const PASSWORD = 'a-real-password-1'

const CSRF = { 'x-csrf-token': 'pk-csrf-90008', 'cookie': 'X-CSRF-Token=pk-csrf-90008' }

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer))
}

// A minimal authenticatorData: rpIdHash(32) + flags(1) + signCount(4).
async function makeAuthData(rpId: string, signCount: number): Promise<Uint8Array> {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId))
  const out = new Uint8Array(37)
  out.set(rpIdHash, 0)
  out[32] = 0x05 // UP | UV
  new DataView(out.buffer).setUint32(33, signCount, false)
  return out
}

function p1363ToDer(sig: Uint8Array): Uint8Array {
  const enc = (x: Uint8Array): Uint8Array => {
    let i = 0
    while (i < x.length - 1 && x[i] === 0) i++
    let v = x.slice(i)
    if (v[0]! & 0x80) { const t = new Uint8Array(v.length + 1); t.set(v, 1); v = t }
    return v
  }
  const r = enc(sig.slice(0, 32))
  const s = enc(sig.slice(32, 64))
  const body = new Uint8Array(2 + r.length + 2 + s.length)
  let o = 0
  body[o++] = 0x02; body[o++] = r.length; body.set(r, o); o += r.length
  body[o++] = 0x02; body[o++] = s.length; body.set(s, o); o += s.length
  const der = new Uint8Array(2 + body.length)
  der[0] = 0x30; der[1] = body.length; der.set(body, 2)
  return der
}

describe('Passkey WebAuthn end-to-end (stacksjs/status#1 Phase 9 follow-up)', () => {
  let userId: number
  let userToken: string
  let keyPair: CryptoKeyPair
  let credentialId: string

  beforeAll(async () => {
    const user = await User.create({ name: 'Passkey User', email: EMAIL, password: PASSWORD })
    userId = user.id
    await db.insertInto('teams').values({ id: TEAM_ID, name: 'Passkey test team' }).execute()
    await db.insertInto('team_members').values({ team_id: TEAM_ID, user_id: userId, role: 'owner', status: 'active', invited_email: EMAIL }).execute()

    const { Auth } = await import('@stacksjs/auth')
    userToken = String((await Auth.loginUsingId(userId, { withRefreshToken: false }))!.token)

    keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    credentialId = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)))
  })

  afterAll(async () => {
    await db.deleteFrom('passkeys').where('user_id', '=', userId).execute()
    await db.deleteFrom('webauthn_challenges').where('user_id', '=', userId).execute()
    await db.deleteFrom('oauth_access_tokens').where('user_id', '=', userId).execute()
    await db.deleteFrom('users').where('id', '=', userId).execute()
    await db.deleteFrom('team_members').where('team_id', '=', TEAM_ID).execute()
    await db.deleteFrom('teams').where('id', '=', TEAM_ID).execute()
  })

  // The enrollment endpoints resolve the user from the auth-token cookie
  // (a dashboard fetch carries no bearer header).
  const authCookie = () => `X-CSRF-Token=pk-csrf-90008; auth-token=${userToken}`

  test('register options rejects an anonymous caller', async () => {
    const res = await featureTest().withHeaders(CSRF).post('/api/passkeys/register/options', {})
    expect(res.status).toBe(401)
  })

  test('enroll then sign in with a passkey, end to end', async () => {
    // 1. Options (authenticated via auth-token cookie).
    const opt = await featureTest().withHeaders({ 'x-csrf-token': 'pk-csrf-90008', 'cookie': authCookie() }).post('/api/passkeys/register/options', {})
    expect(opt.status).toBe(200)
    const options = await opt.json<{ challenge: string, rp: { id: string } }>()
    expect(options.rp.id).toBe(RP_ID)

    // 2. Synthesize the browser's registration response.
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey))
    const regClientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN }))
    const regAuthData = await makeAuthData(RP_ID, 0)
    const verify = await featureTest().withHeaders({ 'x-csrf-token': 'pk-csrf-90008', 'cookie': authCookie() }).post('/api/passkeys/register/verify', {
      id: credentialId,
      deviceType: 'platform',
      response: {
        clientDataJSON: bytesToBase64url(regClientData),
        authenticatorData: bytesToBase64url(regAuthData),
        publicKey: bytesToBase64url(spki),
        publicKeyAlgorithm: -7,
        transports: ['internal'],
      },
    })
    expect(verify.status).toBe(200)
    expect((await verify.json<{ verified: boolean }>()).verified).toBe(true)

    // Row persisted, owned by this user, holding the SPKI key.
    const row = await db.selectFrom('passkeys').selectAll().where('id', '=', credentialId).executeTakeFirst() as { user_id?: number, cred_public_key?: string } | undefined
    expect(Number(row?.user_id)).toBe(userId)
    expect(row?.cred_public_key).toBe(bytesToBase64url(spki))

    // 3. Login options (unauthenticated) — capture the challenge cookie.
    const loginOpt = await featureTest().withHeaders(CSRF).post('/api/passkeys/login/options', {})
    expect(loginOpt.status).toBe(200)
    const loginOptions = await loginOpt.json<{ challenge: string }>()
    const setCookie = loginOpt.headers.get('set-cookie') || ''
    expect(setCookie).toContain('pk_login_challenge=')

    // 4. Synthesize a valid assertion signed by the enrolled key.
    const loginClientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge: loginOptions.challenge, origin: ORIGIN }))
    const loginAuthData = await makeAuthData(RP_ID, 0)
    const clientHash = await sha256(loginClientData)
    const signed = new Uint8Array(loginAuthData.length + clientHash.length)
    signed.set(loginAuthData, 0)
    signed.set(clientHash, loginAuthData.length)
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signed.buffer.slice(0) as ArrayBuffer))
    const der = p1363ToDer(p1363)

    const loginVerify = await featureTest().withHeaders({ 'x-csrf-token': 'pk-csrf-90008', 'cookie': `X-CSRF-Token=pk-csrf-90008; pk_login_challenge=${loginOptions.challenge}` }).post('/api/passkeys/login/verify', {
      id: credentialId,
      response: {
        clientDataJSON: bytesToBase64url(loginClientData),
        authenticatorData: bytesToBase64url(loginAuthData),
        signature: bytesToBase64url(der),
        userHandle: null,
      },
    })
    expect(loginVerify.status).toBe(200)
    const pack = await loginVerify.json<{ token?: string, user?: { id: number } }>()
    expect(pack.token).toBeTruthy()
    expect(pack.user?.id).toBe(userId)
    // Signs the user in via the auth cookie too.
    expect(loginVerify.headers.get('set-cookie') || '').toContain('auth-token=')
    await db.deleteFrom('oauth_access_tokens').where('token', '=', String(pack.token).split('|').pop()).execute().catch(() => {})
  })

  test('a tampered signature is rejected', async () => {
    const loginOpt = await featureTest().withHeaders(CSRF).post('/api/passkeys/login/options', {})
    const { challenge } = await loginOpt.json<{ challenge: string }>()

    const loginClientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }))
    const loginAuthData = await makeAuthData(RP_ID, 0)
    const clientHash = await sha256(loginClientData)
    const signed = new Uint8Array(loginAuthData.length + clientHash.length)
    signed.set(loginAuthData, 0); signed.set(clientHash, loginAuthData.length)
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signed.buffer.slice(0) as ArrayBuffer))
    const der = p1363ToDer(p1363)
    der[der.length - 1] ^= 0x01 // flip a byte in the signature

    const res = await featureTest().withHeaders({ 'x-csrf-token': 'pk-csrf-90008', 'cookie': `X-CSRF-Token=pk-csrf-90008; pk_login_challenge=${challenge}` }).post('/api/passkeys/login/verify', {
      id: credentialId,
      response: {
        clientDataJSON: bytesToBase64url(loginClientData),
        authenticatorData: bytesToBase64url(loginAuthData),
        signature: bytesToBase64url(der),
        userHandle: null,
      },
    })
    expect(res.status).toBe(401)
  })

  test('a wrong-origin assertion is rejected even with a valid signature', async () => {
    const loginOpt = await featureTest().withHeaders(CSRF).post('/api/passkeys/login/options', {})
    const { challenge } = await loginOpt.json<{ challenge: string }>()

    // Sign correctly, but over a clientDataJSON claiming a different origin.
    const loginClientData = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://evil.example.com' }))
    const loginAuthData = await makeAuthData(RP_ID, 0)
    const clientHash = await sha256(loginClientData)
    const signed = new Uint8Array(loginAuthData.length + clientHash.length)
    signed.set(loginAuthData, 0); signed.set(clientHash, loginAuthData.length)
    const p1363 = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, signed.buffer.slice(0) as ArrayBuffer))

    const res = await featureTest().withHeaders({ 'x-csrf-token': 'pk-csrf-90008', 'cookie': `X-CSRF-Token=pk-csrf-90008; pk_login_challenge=${challenge}` }).post('/api/passkeys/login/verify', {
      id: credentialId,
      response: {
        clientDataJSON: bytesToBase64url(loginClientData),
        authenticatorData: bytesToBase64url(loginAuthData),
        signature: bytesToBase64url(p1363ToDer(p1363)),
        userHandle: null,
      },
    })
    expect(res.status).toBe(401)
  })

  test('login verify without a challenge cookie is rejected', async () => {
    const res = await featureTest().withHeaders(CSRF).post('/api/passkeys/login/verify', { id: credentialId, response: {} })
    expect(res.status).toBe(401)
  })
})
