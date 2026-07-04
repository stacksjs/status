import process from 'node:process'
import { config } from '@stacksjs/config'

/**
 * Build the `Set-Cookie` header value that mirrors an issued bearer token
 * into an HttpOnly cookie. The SPA's `useAuth` composable only stores the
 * bearer in localStorage, which is invisible during server-side rendering —
 * the dashboard's `.stx` pages (rendered directly from SQLite, no client
 * hydration) resolve "who's logged in" from this cookie instead.
 *
 * Shared by every auth action that mints a session (LoginAction,
 * RegisterAction, VerifyTwoFactorLoginAction) so the cookie contract stays
 * identical across all three entry points into an authenticated session.
 */
export function buildAuthCookie(token: string, expiresInSeconds?: number): string {
  const name = config.auth?.defaultTokenName || 'auth-token'
  const maxAge = Math.max(1, Math.floor(expiresInSeconds ?? (config.auth?.tokenExpiry ?? 60 * 60 * 1000) / 1000))
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase()
  const isLocal = env === '' || env === 'local' || env === 'development' || env === 'dev' || env === 'test' || env === 'testing'

  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (!isLocal)
    parts.push('Secure')

  return parts.join('; ')
}

/**
 * Clear the auth cookie {@link buildAuthCookie} sets — used by LogoutAction.
 */
export function clearAuthCookie(): string {
  const name = config.auth?.defaultTokenName || 'auth-token'
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
