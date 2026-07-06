import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { response } from '@stacksjs/router'
import { buildAuthCookie } from '../Auth/authCookie'
import { base64urlToBytes, decodeClientData, parseAuthenticatorData, relyingParty, verifyAssertionSignature, verifyClientData, verifyRpIdHash } from './webauthn'

/**
 * `POST /passkeys/login/verify` — finish a passwordless passkey sign-in.
 * Verifies the assertion signature against the stored SPKI public key and,
 * on success, mints the same token pack + HttpOnly auth cookie as
 * LoginAction so the SPA and the server-rendered dashboard are both
 * signed in.
 *
 * Policy: a verified passkey completes login outright — no TOTP step. A
 * passkey is a phishing-resistant possession factor with user
 * verification, i.e. already strong MFA; gating it behind TOTP too would
 * be belt-and-suspenders with no real gain. (LoginAction's password path
 * still enforces TOTP because a password alone is a single weak factor.)
 */
export default new Action({
  name: 'PasskeyLoginVerifyAction',
  description: 'Verify a passkey assertion and sign the user in',

  async handle(request) {
    const challenge = request.cookie('pk_login_challenge')
    const clearChallengeCookie = 'pk_login_challenge=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
    const fail = (message: string, status = 401) =>
      response.json({ verified: false, error: message }, { status, headers: { 'Set-Cookie': clearChallengeCookie } })

    if (!challenge)
      return fail('This sign-in attempt expired — try again.')

    const credentialId = String(request.get('id') ?? '')
    const resp = request.get('response') as Record<string, unknown> | undefined
    if (!credentialId || !resp || typeof resp !== 'object')
      return fail('Malformed assertion.', 400)

    const clientDataJSON = String(resp.clientDataJSON ?? '')
    const authenticatorDataB64 = String(resp.authenticatorData ?? '')
    const signatureB64 = String(resp.signature ?? '')
    if (!clientDataJSON || !authenticatorDataB64 || !signatureB64)
      return fail('Malformed assertion.', 400)

    const row = await db.selectFrom('passkeys').selectAll().where('id', '=', credentialId).executeTakeFirst() as
      { user_id?: number, cred_public_key?: string, counter?: number } | undefined
    if (!row || !row.cred_public_key)
      return fail('Unrecognized passkey.')

    const { rpId, origin } = relyingParty()

    let client
    try {
      client = decodeClientData(clientDataJSON)
    }
    catch {
      return fail('Malformed client data.', 400)
    }

    const clientError = verifyClientData(client, { type: 'webauthn.get', challengeB64url: challenge, origin, rpId })
    if (clientError)
      return fail(`Verification failed: ${clientError}`)

    let authData
    try {
      authData = parseAuthenticatorData(base64urlToBytes(authenticatorDataB64))
    }
    catch {
      return fail('Malformed authenticator data.', 400)
    }

    if (!(await verifyRpIdHash(authData, rpId)))
      return fail('Verification failed: relying-party mismatch.')

    // Clone detection: a non-zero counter must strictly advance. Many
    // platform authenticators (Apple/Google passkeys) always report 0, in
    // which case the check is a no-op by design.
    const storedCounter = Number(row.counter ?? 0)
    if (authData.signCount !== 0 && authData.signCount <= storedCounter)
      return fail('Verification failed: this passkey may have been cloned.')

    const verified = await verifyAssertionSignature({
      spkiPublicKey: base64urlToBytes(String(row.cred_public_key)),
      authenticatorData: base64urlToBytes(authenticatorDataB64),
      clientDataJSON: base64urlToBytes(clientDataJSON),
      signature: base64urlToBytes(signatureB64),
    })
    if (!verified)
      return fail('Verification failed.')

    await db.updateTable('passkeys')
      .set({ counter: authData.signCount, last_used_at: new Date().toISOString() } as never)
      .where('id', '=', credentialId)
      .execute()

    const result = await Auth.loginUsingId(Number(row.user_id))
    if (!result)
      return fail('Account not found for this passkey.')

    const user = result.user
    const headers = new Headers()
    headers.append('Set-Cookie', buildAuthCookie(result.token, result.expiresIn))
    headers.append('Set-Cookie', clearChallengeCookie)
    headers.set('Content-Type', 'application/json')

    log.debug(`[passkey] sign-in for user ${row.user_id}`)
    return new Response(JSON.stringify({
      access_token: result.token,
      refresh_token: result.refreshToken,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      token: result.token,
      user: { id: user?.id, email: user?.email, name: user?.name },
    }), { status: 200, headers })
  },
})
