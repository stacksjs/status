import type { AbstractProvider } from '@stacksjs/socials'
import { env } from '@stacksjs/env'
import { AppleProvider, GitHubProvider, GoogleProvider } from '@stacksjs/socials'

/**
 * Single sign-on (stacksjs/status: SSO). Two families share the same
 * /api/auth/sso/{key} routes and login rules, and differ only in how the
 * IdP round-trip is performed:
 *
 * - kind 'social': Google, Apple, GitHub via the @stacksjs/socials
 *   drivers (credentials live in config/services.ts). This is the
 *   consumer "Continue with ..." login/signup path.
 * - kind 'oidc': Okta, Entra ID, and any spec-compliant OIDC issuer via
 *   the hand-rolled discovery + PKCE flow in app/Actions/Auth/oidc.ts.
 *   This is the enterprise SSO path.
 *
 * Providers are enabled by setting their env vars; anything unset simply
 * doesn't appear on the login page.
 *
 * The redirect URI to register with the IdP is always:
 *   {APP_URL}/api/auth/sso/{key}/callback
 * (Apple additionally POSTs to it — response_mode=form_post.)
 */
export interface SsoProvider {
  /** Shown on the login button ("Continue with {label}"). */
  label: string
  kind: 'social' | 'oidc'
  /** OIDC only: issuer base URL; discovery doc lives at {issuer}/.well-known/openid-configuration. */
  issuer?: string
  /** OIDC only — social drivers read credentials from config/services.ts. */
  clientId?: string
  clientSecret?: string
}

function oidc(label: string, issuer?: string, clientId?: string, clientSecret?: string): SsoProvider | null {
  if (!issuer || !clientId || !clientSecret)
    return null
  return { label, kind: 'oidc', issuer, clientId, clientSecret }
}

function social(label: string, ...requiredEnv: (string | undefined)[]): SsoProvider | null {
  if (requiredEnv.some(value => !value))
    return null
  return { label, kind: 'social' }
}

const entraTenant = env.SSO_ENTRA_TENANT_ID ? String(env.SSO_ENTRA_TENANT_ID) : ''

export const SSO_PROVIDERS: Record<string, SsoProvider> = Object.fromEntries(
  Object.entries({
    google: social(
      'Google',
      String(env.GOOGLE_CLIENT_ID || env.SSO_GOOGLE_CLIENT_ID || ''),
      String(env.GOOGLE_CLIENT_SECRET || env.SSO_GOOGLE_CLIENT_SECRET || ''),
    ),
    apple: social(
      'Apple',
      String(env.APPLE_CLIENT_ID || ''),
      String(env.APPLE_TEAM_ID || ''),
      String(env.APPLE_KEY_ID || ''),
      String(env.APPLE_PRIVATE_KEY || ''),
    ),
    github: social(
      'GitHub',
      String(env.GITHUB_CLIENT_ID || ''),
      String(env.GITHUB_CLIENT_SECRET || ''),
    ),
    okta: oidc(
      'Okta',
      env.SSO_OKTA_ISSUER ? String(env.SSO_OKTA_ISSUER) : undefined,
      env.SSO_OKTA_CLIENT_ID ? String(env.SSO_OKTA_CLIENT_ID) : undefined,
      env.SSO_OKTA_CLIENT_SECRET ? String(env.SSO_OKTA_CLIENT_SECRET) : undefined,
    ),
    entra: oidc(
      'Microsoft',
      entraTenant ? `https://login.microsoftonline.com/${entraTenant}/v2.0` : undefined,
      env.SSO_ENTRA_CLIENT_ID ? String(env.SSO_ENTRA_CLIENT_ID) : undefined,
      env.SSO_ENTRA_CLIENT_SECRET ? String(env.SSO_ENTRA_CLIENT_SECRET) : undefined,
    ),
    // Generic escape hatch: any spec-compliant OIDC issuer (Keycloak,
    // Authentik, Authelia, Zitadel, ...). Label is configurable so the
    // login button can say "Continue with Acme SSO".
    oidc: oidc(
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

/**
 * Driver factory for kind 'social'. A fresh instance per request —
 * withState()/setRedirectUrl() mutate the instance, so sharing one
 * across concurrent logins would cross wires.
 */
export function createSocialProvider(key: string): AbstractProvider | null {
  // Credentials come from config.services.* (see config/services.ts) —
  // the constructor args are instance-level overrides we don't need.
  const blank = { clientId: '', clientSecret: '', redirectUrl: '' }
  switch (key) {
    case 'google':
      return new GoogleProvider(blank)
    case 'apple':
      return new AppleProvider(blank)
    case 'github':
      return new GitHubProvider(blank)
    default:
      return null
  }
}

/** [key, label] pairs for rendering login buttons. */
export function enabledSsoProviders(): Array<{ key: string, label: string }> {
  return Object.entries(SSO_PROVIDERS).map(([key, p]) => ({ key, label: p.label }))
}
