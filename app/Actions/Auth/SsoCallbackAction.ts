import { Action } from '@stacksjs/actions'
import { Team, User } from '@stacksjs/orm'
import SsoIdentity from '../../Models/SsoIdentity'
import TeamMember from '../../Models/TeamMember'
import { ssoProvider } from '../../../config/sso'
import { buildAuthCookie } from './authCookie'
import { clearFlowCookie, decodeJwtPayload, discover, randomToken, readFlowCookie, redirectUri } from './oidc'

/**
 * Second leg of OIDC login: GET /api/auth/sso/{provider}/callback.
 *
 * Validates the signed flow cookie (state match, freshness), exchanges
 * the code (with the PKCE verifier), and validates the id_token claims:
 * iss must equal the discovery issuer, aud must contain our client_id,
 * exp in the future, nonce must match the one we sent. Signature
 * checking is intentionally replaced by TLS server validation, which
 * OIDC Core 3.1.3.7 permits for the code flow (see oidc.ts docblock).
 *
 * Account rules:
 * - (provider, sub) already linked: log that user in.
 * - Unlinked but a user exists with the IdP-asserted email: link and log
 *   in, unless the IdP says email_verified === false (an unverified
 *   address must never take over an existing local account).
 * - No user: provision one (random password, own team), mirroring
 *   RegisterAction, then link.
 *
 * Local TOTP 2FA is deliberately not challenged on this path: the IdP
 * owns the authentication ceremony (and typically its own MFA), which is
 * the same call Oh Dear and most SaaS make for SSO logins.
 *
 * Every failure lands on /login?error=... rather than a JSON error,
 * because this is a full-page browser navigation.
 */

function fail(reason: string): Response {
  return new Response(null, {
    status: 302,
    headers: { 'Location': `/login?error=${reason}`, 'Set-Cookie': clearFlowCookie() },
  })
}

export default new Action({
  name: 'SsoCallbackAction',
  description: 'Complete an OIDC single sign-on flow',

  async handle(request) {
    const providerKey = String(request.get('provider') ?? '')
    const provider = ssoProvider(providerKey)
    if (!provider)
      return fail('sso_unknown_provider')

    // IdPs report user cancellation / consent errors via ?error=.
    const idpError = request.get('error')
    if (idpError)
      return fail('sso_denied')

    const code = String(request.get('code') ?? '')
    const state = String(request.get('state') ?? '')
    if (!code || !state)
      return fail('sso_missing_code')

    const flow = readFlowCookie(request.headers.get('cookie'))
    if (!flow || flow.provider !== providerKey || flow.state !== state)
      return fail('sso_state_mismatch')

    let discovery
    try {
      discovery = await discover(provider.issuer)
    }
    catch {
      return fail('sso_discovery_failed')
    }

    // --- Code exchange (confidential client + PKCE) -------------------
    let tokens: { id_token?: string, access_token?: string }
    try {
      const res = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(request.headers, providerKey),
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          code_verifier: flow.verifier,
        }),
      })
      if (!res.ok) {
        console.error(`[SsoCallbackAction] token exchange failed for ${providerKey}: HTTP ${res.status} ${await res.text()}`)
        return fail('sso_exchange_failed')
      }
      tokens = await res.json() as typeof tokens
    }
    catch (error) {
      console.error(`[SsoCallbackAction] token exchange errored for ${providerKey}:`, error)
      return fail('sso_exchange_failed')
    }

    if (!tokens.id_token)
      return fail('sso_no_id_token')

    // --- id_token claim validation ------------------------------------
    let claims: Record<string, unknown>
    try {
      claims = decodeJwtPayload(tokens.id_token)
    }
    catch {
      return fail('sso_bad_id_token')
    }

    const aud = claims.aud
    const audOk = Array.isArray(aud) ? aud.includes(provider.clientId) : aud === provider.clientId
    const expOk = typeof claims.exp === 'number' && claims.exp * 1000 > Date.now()
    const issOk = claims.iss === discovery.issuer
    const nonceOk = claims.nonce === flow.nonce
    if (!audOk || !expOk || !issOk || !nonceOk)
      return fail('sso_bad_id_token')

    const subject = String(claims.sub ?? '')
    if (!subject)
      return fail('sso_bad_id_token')

    let email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    let name = typeof claims.name === 'string' ? claims.name : ''
    const emailVerified = claims.email_verified

    // Some IdPs (notably Okta with minimal scopes) omit profile claims
    // from the id_token; the userinfo endpoint fills the gap.
    if ((!email || !name) && discovery.userinfo_endpoint && tokens.access_token) {
      try {
        const res = await fetch(discovery.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        if (res.ok) {
          const info = await res.json() as Record<string, unknown>
          if (!email && typeof info.email === 'string')
            email = info.email.toLowerCase()
          if (!name && typeof info.name === 'string')
            name = info.name
        }
      }
      catch {
        // userinfo is best-effort; the id_token claims may already suffice
      }
    }

    if (!email)
      return fail('sso_no_email')

    // --- Resolve or provision the local user --------------------------
    let userId: number | null = null

    const identity = await SsoIdentity.where('provider', providerKey).where('subject', subject).first()
    if (identity) {
      userId = identity.user_id as number
    }
    else {
      const existing = await User.where('email', email).first()
      if (existing) {
        // Linking an IdP identity to an existing local account by email
        // is only safe when the IdP vouches for the address.
        if (emailVerified === false)
          return fail('sso_email_unverified')
        userId = existing.id as number
      }
      else {
        // Provision through the regular registration path so hashing,
        // token minting, and events all stay in one code path. The
        // password is random and never shown; password login stays
        // possible only via the reset flow, which requires the inbox.
        const result = await register({ email, name: name || email.split('@')[0], password: randomToken(32) })
        if (!result)
          return fail('sso_provisioning_failed')
        const created = await User.where('email', email).first()
        if (!created)
          return fail('sso_provisioning_failed')
        userId = created.id as number

        // Give the new user a team to own, exactly like RegisterAction
        // (best-effort there, best-effort here, same reasoning).
        try {
          const existingMembership = await TeamMember.where('user_id', userId).where('status', 'active').first()
          if (!existingMembership) {
            const team = await Team.forceCreate({
              name: name ? `${name}'s Team` : 'My Team',
              status: 'active',
              user_id: userId,
              owner: email,
            })
            await TeamMember.create({
              team_id: team.id,
              user_id: userId,
              role: 'owner',
              status: 'active',
              joined_at: new Date().toISOString(),
            })
          }
        }
        catch (err) {
          console.error('[SsoCallbackAction] failed to create default team', err)
        }

        dispatch('user:registered', { id: userId, email, name, to: email })
      }

      await SsoIdentity.create({
        user_id: userId,
        provider: providerKey,
        subject,
        email,
      })
    }

    const session = await Auth.loginUsingId(userId)
    if (!session)
      return fail('sso_login_failed')

    // Two Set-Cookie headers (auth + flow clear) via Headers.append —
    // a plain object would collapse them into one.
    const headers = new Headers({ Location: '/dashboard/monitors' })
    headers.append('Set-Cookie', buildAuthCookie(session.token, session.expiresIn))
    headers.append('Set-Cookie', clearFlowCookie())
    return new Response(null, { status: 302, headers })
  },
})
