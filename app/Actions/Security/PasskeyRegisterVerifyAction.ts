import { Action } from '@stacksjs/actions'
import { consumeWebAuthnChallenge, resolveAuthenticatedUser } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { response } from '@stacksjs/router'
import { base64urlToBytes, decodeClientData, parseAuthenticatorData, relyingParty, verifyClientData, verifyRpIdHash } from './webauthn'

/**
 * `POST /passkeys/register/verify` — finish enrollment. The browser posts
 * the credential id, the authenticator data, and the SPKI public key
 * (`getPublicKey()`), all base64url. We verify the ceremony (type,
 * server-issued challenge, origin, rpIdHash) and store the SPKI key +
 * credential id + counter for future logins.
 *
 * Attestation is 'none': there is no signature at registration, so trust
 * rests on (a) the caller being an authenticated user and (b) the
 * challenge being server-issued and single-use — a client can only enroll
 * a key against its OWN account, and can only lock itself out by
 * registering a key it can't later sign with. We store the browser's SPKI
 * `getPublicKey()` (not ts-auth's COSE bytes), which is what the login
 * verifier imports.
 */
export default new Action({
  name: 'PasskeyRegisterVerifyAction',
  description: 'Verify and store a new passkey for the signed-in user',

  async handle(request) {
    const user = await resolveAuthenticatedUser(request)
    if (!user)
      return response.unauthorized('Authentication required')

    const storedChallenge = await consumeWebAuthnChallenge(user.id, 'registration')
    if (!storedChallenge)
      return response.json({ verified: false, error: 'Registration session expired — start again.' }, { status: 400 })

    const credentialId = String(request.get('id') ?? '')
    const resp = request.get('response') as Record<string, unknown> | undefined
    if (!credentialId || !resp || typeof resp !== 'object')
      return response.json({ verified: false, error: 'Malformed credential.' }, { status: 400 })

    const clientDataJSON = String(resp.clientDataJSON ?? '')
    const authenticatorDataB64 = String(resp.authenticatorData ?? '')
    const publicKeyB64 = String(resp.publicKey ?? '')
    const publicKeyAlgorithm = Number(resp.publicKeyAlgorithm ?? 0)
    if (!clientDataJSON || !authenticatorDataB64 || !publicKeyB64)
      return response.json({ verified: false, error: 'Malformed credential.' }, { status: 400 })

    // ES256 only — matches the login verifier's ECDSA P-256 import.
    if (publicKeyAlgorithm !== -7)
      return response.json({ verified: false, error: 'Unsupported key type — only ES256 passkeys are supported.' }, { status: 400 })

    const { rpId, origin } = relyingParty()

    let client
    try {
      client = decodeClientData(clientDataJSON)
    }
    catch {
      return response.json({ verified: false, error: 'Malformed client data.' }, { status: 400 })
    }

    const clientError = verifyClientData(client, { type: 'webauthn.create', challengeB64url: storedChallenge, origin, rpId })
    if (clientError)
      return response.json({ verified: false, error: `Verification failed: ${clientError}` }, { status: 400 })

    let authData
    try {
      authData = parseAuthenticatorData(base64urlToBytes(authenticatorDataB64))
    }
    catch {
      return response.json({ verified: false, error: 'Malformed authenticator data.' }, { status: 400 })
    }

    if (!(await verifyRpIdHash(authData, rpId)))
      return response.json({ verified: false, error: 'Verification failed: relying-party mismatch.' }, { status: 400 })

    // A credential id is globally unique; if it already belongs to another
    // account, refuse rather than reassign it.
    const clash = await db.selectFrom('passkeys').selectAll().where('id', '=', credentialId).executeTakeFirst() as { user_id?: number } | undefined
    if (clash && Number(clash.user_id) !== user.id)
      return response.json({ verified: false, error: 'That passkey is already registered.' }, { status: 409 })

    const deviceType = String(request.get('deviceType') ?? '').slice(0, 50) || null
    const transports = Array.isArray(resp.transports) ? JSON.stringify(resp.transports).slice(0, 255) : null
    const nowIso = new Date().toISOString()

    if (clash) {
      // Re-enrolling the same credential for the same user — refresh key/counter.
      await db.updateTable('passkeys')
        .set({ cred_public_key: publicKeyB64, counter: authData.signCount, last_used_at: nowIso } as never)
        .where('id', '=', credentialId)
        .execute()
    }
    else {
      await db.insertInto('passkeys').values({
        id: credentialId,
        cred_public_key: publicKeyB64,
        user_id: user.id,
        webauthn_user_id: user.email || String(user.id),
        counter: authData.signCount,
        credential_type: 'public-key',
        device_type: deviceType,
        transports,
        created_at: nowIso,
      } as never).execute()
    }

    log.debug(`[passkey] registered credential for user ${user.id}`)
    return response.json({ verified: true })
  },
})
