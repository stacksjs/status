import { Action } from '@stacksjs/actions'
import { createSocialProvider, ssoProvider } from '../../../config/sso'
import { buildFlowCookie, discover, pkceChallenge, randomToken, redirectUri } from './oidc'

/**
 * First leg of SSO login: GET /api/auth/sso/{provider}. Generates
 * state (CSRF) — plus nonce (token replay) and a PKCE verifier for the
 * flows that use them — stashes them in a signed short-lived cookie (no
 * server session store exists to hold them), and bounces the browser to
 * the IdP's authorization endpoint. The callback leg lives in
 * SsoCallbackAction.
 *
 * kind 'social' (Google, Apple, GitHub) builds the URL via the
 * @stacksjs/socials driver; kind 'oidc' (Okta, Entra, generic) via OIDC
 * discovery. Apple gets a nonce (its id_token echoes it back) and a
 * SameSite=None flow cookie (its callback is a cross-site form POST).
 */
export default new Action({
  name: 'SsoRedirectAction',
  description: 'Start a single sign-on flow',

  async handle(request) {
    const providerKey = String(request.get('provider') ?? '')
    const provider = ssoProvider(providerKey)
    if (!provider)
      return new Response(null, { status: 302, headers: { Location: '/login?error=sso_unknown_provider' } })

    const state = randomToken()
    const nonce = randomToken()

    if (provider.kind === 'social') {
      let authorizationUrl: string
      try {
        const driver = createSocialProvider(providerKey)
        if (!driver)
          return new Response(null, { status: 302, headers: { Location: '/login?error=sso_unknown_provider' } })

        driver
          .withState(state)
          .setRedirectUrl(redirectUri(request.headers, providerKey))

        if (providerKey === 'apple')
          driver.with({ nonce })

        authorizationUrl = await driver.getAuthUrl()
      }
      catch (error) {
        // ConfigException (missing credentials) lands here too.
        console.error(`[SsoRedirectAction] could not build auth URL for ${providerKey}:`, error)
        return new Response(null, { status: 302, headers: { Location: '/login?error=sso_misconfigured' } })
      }

      return new Response(null, {
        status: 302,
        headers: {
          'Location': authorizationUrl,
          'Set-Cookie': buildFlowCookie(
            { provider: providerKey, state, nonce, verifier: '', issuedAt: Date.now() },
            { crossSitePost: providerKey === 'apple' },
          ),
        },
      })
    }

    // --- kind 'oidc' ---------------------------------------------------
    let authorizationEndpoint: string
    try {
      const discovery = await discover(provider.issuer!)
      authorizationEndpoint = discovery.authorization_endpoint
    }
    catch (error) {
      console.error(`[SsoRedirectAction] discovery failed for ${providerKey}:`, error)
      return new Response(null, { status: 302, headers: { Location: '/login?error=sso_discovery_failed' } })
    }

    const verifier = randomToken(48)
    const challenge = await pkceChallenge(verifier)

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId!,
      redirect_uri: redirectUri(request.headers, providerKey),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })

    return new Response(null, {
      status: 302,
      headers: {
        'Location': `${authorizationEndpoint}?${params.toString()}`,
        'Set-Cookie': buildFlowCookie({ provider: providerKey, state, nonce, verifier, issuedAt: Date.now() }),
      },
    })
  },
})
