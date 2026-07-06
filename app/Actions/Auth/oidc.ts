import { Buffer } from 'node:buffer'
import { createHmac, randomBytes } from 'node:crypto'
import process from 'node:process'

/**
 * Minimal OIDC authorization-code + PKCE plumbing shared by
 * SsoRedirectAction and SsoCallbackAction. Deliberately dependency-free:
 * discovery + token exchange are plain fetches, and the id_token is
 * accepted WITHOUT local signature verification because we only ever
 * receive it straight from the token endpoint over TLS as a confidential
 * client. OIDC Core 3.1.3.7 explicitly allows TLS server validation in
 * place of signature checking in that flow; the claims (iss, aud, exp,
 * nonce) are still validated in the callback action.
 */

export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
}

const discoveryCache = new Map<string, { doc: OidcDiscovery, fetchedAt: number }>()
const DISCOVERY_TTL_MS = 60 * 60 * 1000

export async function discover(issuer: string): Promise<OidcDiscovery> {
  const base = issuer.replace(/\/$/, '')
  const cached = discoveryCache.get(base)
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS)
    return cached.doc

  const res = await fetch(`${base}/.well-known/openid-configuration`)
  if (!res.ok)
    throw new Error(`OIDC discovery failed for ${base}: HTTP ${res.status}`)

  const doc = await res.json() as OidcDiscovery
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint)
    throw new Error(`OIDC discovery document for ${base} is missing required fields`)

  discoveryCache.set(base, { doc, fetchedAt: Date.now() })
  return doc
}

export function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomToken(bytes = 32): string {
  return base64url(randomBytes(bytes))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(Buffer.from(digest))
}

/** Decode a JWT's payload without verifying it (see module docblock for why that's acceptable here). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  if (parts.length !== 3)
    throw new Error('Malformed JWT')
  const payload = Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(payload)
}

// ---------------------------------------------------------------------
// Signed, short-lived flow cookie: carries state/nonce/PKCE verifier
// across the IdP round-trip (there is no server-side session store to
// put them in). HMAC-SHA256 over the payload with APP_KEY prevents
// tampering; the callback rejects anything older than FLOW_MAX_AGE.
// ---------------------------------------------------------------------

export const SSO_FLOW_COOKIE = 'sso-flow'
const FLOW_MAX_AGE_SECONDS = 600

export interface SsoFlowState {
  provider: string
  state: string
  nonce: string
  verifier: string
  issuedAt: number
}

function hmacKey(): string {
  const key = process.env.APP_KEY
  if (!key)
    throw new Error('APP_KEY must be set for SSO (it signs the flow cookie)')
  return key
}

function sign(payload: string): string {
  return base64url(createHmac('sha256', hmacKey()).update(payload).digest())
}

export function buildFlowCookie(flow: SsoFlowState, options: { crossSitePost?: boolean } = {}): string {
  const payload = base64url(JSON.stringify(flow))
  const value = `${payload}.${sign(payload)}`
  const env = (process.env.APP_ENV ?? '').toLowerCase()
  const isLocal = env === '' || env === 'local' || env === 'development' || env === 'dev' || env === 'test' || env === 'testing'
  // Apple's form_post callback arrives as a cross-site POST, which a
  // SameSite=Lax cookie never accompanies — the flow would always die
  // with sso_state_mismatch. SameSite=None requires Secure, which is
  // fine: Apple doesn't allow plain-http redirect URIs anyway.
  const sameSite = options.crossSitePost ? 'SameSite=None; Secure' : 'SameSite=Lax'
  const parts = [`${SSO_FLOW_COOKIE}=${value}`, 'Path=/', 'HttpOnly', sameSite, `Max-Age=${FLOW_MAX_AGE_SECONDS}`]
  if (!isLocal && !options.crossSitePost)
    parts.push('Secure')
  return parts.join('; ')
}

export function clearFlowCookie(): string {
  return `${SSO_FLOW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export function readFlowCookie(cookieHeader: string | null): SsoFlowState | null {
  if (!cookieHeader)
    return null
  const raw = cookieHeader
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${SSO_FLOW_COOKIE}=`))
    ?.slice(SSO_FLOW_COOKIE.length + 1)
  if (!raw)
    return null

  const [payload, signature] = raw.split('.')
  if (!payload || !signature || sign(payload) !== signature)
    return null

  try {
    const flow = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as SsoFlowState
    // verifier is '' for the social (non-PKCE) flows — only its absence
    // (a malformed payload) is invalid.
    if (!flow.state || !flow.provider || typeof flow.verifier !== 'string')
      return null
    if (Date.now() - flow.issuedAt > FLOW_MAX_AGE_SECONDS * 1000)
      return null
    return flow
  }
  catch {
    return null
  }
}

/**
 * The origin to build the OIDC redirect_uri from. Derived from the
 * request (honoring x-forwarded-proto behind the reverse proxy) so dev,
 * self-hosted, and hosted installs all get the right value without extra
 * config. Must match the redirect URI registered with the IdP.
 *
 * Production wrinkle: the box's reverse proxy rewrites Host to its
 * upstream (`localhost:3000`) and forwards no x-forwarded-host, so a
 * loopback host in a production-like env can never be the real public
 * origin — fall back to APP_URL there. (Observed live 2026-07-06:
 * redirect_uri went out as http://localhost:3000/... and GitHub/Google
 * rejected the mismatch.) Dev keeps the header-derived origin so
 * localhost:4650 etc. work without config.
 */
export function requestOrigin(headers: Headers): string {
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? process.env.APP_URL ?? 'localhost'
  const forwardedProto = headers.get('x-forwarded-proto')
  const bareHost = host.split(':')[0] ?? host
  const isLocalHost = bareHost === 'localhost' || bareHost === '127.0.0.1' || bareHost.endsWith('.localhost')

  const env = (process.env.APP_ENV ?? '').toLowerCase()
  const isProdLike = env === 'production' || env === 'staging'
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '')
  if (isProdLike && isLocalHost && appUrl && !appUrl.includes('localhost'))
    return appUrl.includes('://') ? appUrl : `https://${appUrl}`

  const proto = forwardedProto ?? (isLocalHost ? 'http' : 'https')
  return `${proto}://${host}`
}

export function redirectUri(headers: Headers, provider: string): string {
  return `${requestOrigin(headers)}/api/auth/sso/${provider}/callback`
}
