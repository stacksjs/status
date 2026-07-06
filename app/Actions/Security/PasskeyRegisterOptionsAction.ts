import { Action } from '@stacksjs/actions'
import { getUserPasskeys, resolveAuthenticatedUser, storeWebAuthnChallenge } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { response } from '@stacksjs/router'
import { bytesToBase64url, relyingParty } from './webauthn'

/**
 * `POST /passkeys/register/options` — start a passkey enrollment for the
 * signed-in user (stacksjs/status#1 Phase 9 follow-up). Returns the
 * WebAuthn creation options the browser feeds to
 * `navigator.credentials.create()`, in a JSON-safe shape (challenge and
 * credential ids as base64url strings — the client decodes them to bytes).
 *
 * The challenge is a server-issued random nonce stashed server-side
 * (webauthn_challenges, single-outstanding per user, 5 min TTL); the
 * verify step compares against that copy, so a client can't choose its
 * own. Auth is the HttpOnly auth-token cookie via resolveAuthenticatedUser
 * (this route is NOT behind the bearer/session Auth middleware — a
 * dashboard fetch only has that cookie).
 */
export default new Action({
  name: 'PasskeyRegisterOptionsAction',
  description: 'Issue WebAuthn registration options for the signed-in user',

  async handle(request) {
    const user = await resolveAuthenticatedUser(request)
    if (!user)
      return response.unauthorized('Authentication required')

    const { rpId } = relyingParty()
    const challengeBytes = crypto.getRandomValues(new Uint8Array(32))
    const challenge = bytesToBase64url(challengeBytes)
    await storeWebAuthnChallenge(user.id, challenge, 'registration')

    const existing = await getUserPasskeys(user.id)

    return response.json({
      challenge,
      rp: { id: rpId, name: config.app?.name || 'UptimeStatus' },
      user: {
        // A stable per-user handle. base64url of the numeric id keeps it
        // an opaque byte string for the authenticator; the client decodes
        // it to bytes before calling create().
        id: bytesToBase64url(new TextEncoder().encode(String(user.id))),
        name: user.email || `user-${user.id}`,
        displayName: user.email || `user-${user.id}`,
      },
      // ES256 only — the app's verifier imports the stored key as ECDSA
      // P-256, so advertising RS256 would enroll keys that can never sign
      // in. Reject anything else at verify time too.
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
      excludeCredentials: existing.map(p => ({ id: p.id, type: 'public-key' })),
      timeout: 60000,
    })
  },
})
