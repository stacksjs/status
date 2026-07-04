import { env } from '@stacksjs/env'

/**
 * Single sign-on via OIDC (stacksjs/status: SSO). Providers are enabled
 * by setting their env vars; anything unset simply doesn't appear on the
 * login page. All four entries speak the same protocol (authorization
 * code + PKCE against the issuer's /.well-known/openid-configuration),
 * so "Entra ID support" is just a well-known issuer URL, not a driver.
 *
 * The redirect URI to register with the IdP is always:
 *   {APP_URL}/api/auth/sso/{key}/callback
 */
export interface SsoProvider {
  /** Shown on the login button ("Continue with {label}"). */
  label: string
  /** OIDC issuer base URL; discovery doc lives at {issuer}/.well-known/openid-configuration. */
  issuer: string
  clientId: string
  clientSecret: string
}

function provider(label: string, issuer?: string, clientId?: string, clientSecret?: string): SsoProvider | null {
  if (!issuer || !clientId || !clientSecret)
    return null
  return { label, issuer, clientId, clientSecret }
}

const entraTenant = env.SSO_ENTRA_TENANT_ID ? String(env.SSO_ENTRA_TENANT_ID) : ''

export const SSO_PROVIDERS: Record<string, SsoProvider> = Object.fromEntries(
  Object.entries({
    google: provider(
      'Google',
      'https://accounts.google.com',
      env.SSO_GOOGLE_CLIENT_ID ? String(env.SSO_GOOGLE_CLIENT_ID) : undefined,
      env.SSO_GOOGLE_CLIENT_SECRET ? String(env.SSO_GOOGLE_CLIENT_SECRET) : undefined,
    ),
    okta: provider(
      'Okta',
      env.SSO_OKTA_ISSUER ? String(env.SSO_OKTA_ISSUER) : undefined,
      env.SSO_OKTA_CLIENT_ID ? String(env.SSO_OKTA_CLIENT_ID) : undefined,
      env.SSO_OKTA_CLIENT_SECRET ? String(env.SSO_OKTA_CLIENT_SECRET) : undefined,
    ),
    entra: provider(
      'Microsoft',
      entraTenant ? `https://login.microsoftonline.com/${entraTenant}/v2.0` : undefined,
      env.SSO_ENTRA_CLIENT_ID ? String(env.SSO_ENTRA_CLIENT_ID) : undefined,
      env.SSO_ENTRA_CLIENT_SECRET ? String(env.SSO_ENTRA_CLIENT_SECRET) : undefined,
    ),
    // Generic escape hatch: any spec-compliant OIDC issuer (Keycloak,
    // Authentik, Authelia, Zitadel, ...). Label is configurable so the
    // login button can say "Continue with Acme SSO".
    oidc: provider(
      env.SSO_OIDC_LABEL ? String(env.SSO_OIDC_LABEL) : 'SSO',
      env.SSO_OIDC_ISSUER ? String(env.SSO_OIDC_ISSUER) : undefined,
      env.SSO_OIDC_CLIENT_ID ? String(env.SSO_OIDC_CLIENT_ID) : undefined,
      env.SSO_OIDC_CLIENT_SECRET ? String(env.SSO_OIDC_CLIENT_SECRET) : undefined,
    ),
  }).filter(([, value]) => value !== null) as [string, SsoProvider][],
)

export function ssoProvider(key: string): SsoProvider | null {
  return SSO_PROVIDERS[key] ?? null
}

/** [key, label] pairs for rendering login buttons. */
export function enabledSsoProviders(): Array<{ key: string, label: string }> {
  return Object.entries(SSO_PROVIDERS).map(([key, p]) => ({ key, label: p.label }))
}
