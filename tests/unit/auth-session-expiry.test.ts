import { describe, expect, test } from 'bun:test'
import authConfig from '../../config/auth'
import { buildAuthCookie } from '../../app/Actions/Auth/authCookie'

/**
 * `tokenExpiry` is the browser session length, not just an API-bearer TTL.
 *
 * LoginAction mirrors the issued access token into the HttpOnly `auth-token`
 * cookie because the dashboard is server-rendered stx with no client
 * hydration; both that cookie's Max-Age and the `oauth_access_tokens`
 * `expires_at` row come from this one number, and nothing extends either.
 * At the old 1-hour default an operator was signed out mid-click an hour
 * after login no matter how actively they were using the dashboard.
 *
 * The value looks like a security knob, so it is an easy thing to "harden"
 * back down without realising a session rides on it. These assertions make
 * that a test failure rather than a support ticket.
 */
describe('auth config: session length', () => {
  const HOUR = 60 * 60 * 1000

  test('a session lasts 24 hours by default', () => {
    expect(authConfig.tokenExpiry).toBe(24 * HOUR)
  })

  test('sessions outlive a working day, since nothing renews them', () => {
    // The floor that matters in practice: anything at or under an hour
    // reintroduces the original complaint. Kept as a range rather than an
    // equality so the exact figure stays tunable.
    expect(authConfig.tokenExpiry).toBeGreaterThan(8 * HOUR)
  })

  test('no idle timeout — activity is not tracked as a session signal', () => {
    // @stacksjs/auth's getUserFromToken revokes a token when
    // `config.auth.idleTimeout` is set and `updated_at` is older than it.
    // Deliberately unset: expiry here is absolute-from-login only.
    expect((authConfig as { idleTimeout?: number }).idleTimeout).toBeUndefined()
  })

  test('the login cookie carries the same lifetime the config declares', () => {
    // Guards the units seam: Auth.createTokenForUser returns `expiresIn` in
    // SECONDS while tokenExpiry is in MILLISECONDS, and buildAuthCookie
    // divides only on its fallback path. A regression either way is a
    // 1000x-wrong Max-Age, which reads as "session ends instantly" or
    // "session never ends".
    const cookie = buildAuthCookie('test-token')
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1])

    expect(maxAge).toBe(authConfig.tokenExpiry / 1000)
  })

  test('an explicit expiresIn from the login flow wins over the config default', () => {
    const cookie = buildAuthCookie('test-token', 3600)

    expect(cookie).toContain('Max-Age=3600')
  })

  test('the cookie stays HttpOnly and SameSite=Lax at any lifetime', () => {
    // A longer-lived cookie is only acceptable while it remains unreadable
    // from JS; the nav's signed-in state must not be implemented by
    // relaxing this.
    const cookie = buildAuthCookie('test-token')

    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })
})
