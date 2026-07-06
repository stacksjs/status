import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { bytesToBase64url, relyingParty } from './webauthn'

/**
 * `POST /passkeys/login/options` — start a passwordless passkey sign-in
 * (unauthenticated). Returns WebAuthn request options for
 * `navigator.credentials.get()`.
 *
 * The user is unknown at this point, so the challenge can't be keyed to a
 * user row (unlike registration). It is stashed in a short-lived HttpOnly
 * cookie instead — the browser can't read or forge it, and the verify
 * step trusts that server-set copy rather than anything the client echoes.
 * allowCredentials is left empty so the flow works with discoverable
 * (resident) passkeys without an email-first step (which would also be a
 * user-enumeration oracle).
 */
export default new Action({
  name: 'PasskeyLoginOptionsAction',
  description: 'Issue WebAuthn authentication options for passkey sign-in',

  async handle() {
    const { rpId } = relyingParty()
    const challengeBytes = crypto.getRandomValues(new Uint8Array(32))
    const challenge = bytesToBase64url(challengeBytes)

    const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase()
    const isLocal = env === '' || env === 'local' || env === 'development' || env === 'dev' || env === 'test' || env === 'testing'
    const cookieParts = [`pk_login_challenge=${challenge}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=300']
    if (!isLocal)
      cookieParts.push('Secure')

    return response.json({
      challenge,
      rpId,
      allowCredentials: [],
      userVerification: 'preferred',
      timeout: 60000,
    }, { headers: { 'Set-Cookie': cookieParts.join('; ') } })
  },
})
