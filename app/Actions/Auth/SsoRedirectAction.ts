import { Action } from '@stacksjs/actions'
import { ssoProvider } from '../../../config/sso'
import { buildFlowCookie, discover, pkceChallenge, randomToken, redirectUri } from './oidc'

/**
 * First leg of OIDC login: GET /api/auth/sso/{provider}. Generates
 * state (CSRF), nonce (token replay), and a PKCE verifier, stashes all
 * three in a signed short-lived cookie (no server session store exists
 * to hold them), and bounces the browser to the IdP's authorization
 * endpoint. The callback leg lives in SsoCallbackAction.
 */
export default new Action({
  name: 'SsoRedirectAction',
  description: 'Start an OIDC single sign-on flow',

  async handle(request) {
    const providerKey = String(request.get('provider') ?? '')
    const provider = ssoProvider(providerKey)
    if (!provider)
      return new Response(null, { status: 302, headers: { Location: '/login?error=sso_unknown_provider' } })

    let authorizationEndpoint: string
    try {
      const discovery = await discover(provider.issuer)
      authorizationEndpoint = discovery.authorization_endpoint
    }
    catch (error) {
      console.error(`[SsoRedirectAction] discovery failed for ${providerKey}:`, error)
      return new Response(null, { status: 302, headers: { Location: '/login?error=sso_discovery_failed' } })
    }

    const state = randomToken()
    const nonce = randomToken()
    const verifier = randomToken(48)
    const challenge = await pkceChallenge(verifier)

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: provider.clientId,
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
