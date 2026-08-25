import type { AuthConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Authentication Configuration**
 *
 * This configuration defines all of your authentication options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  enabled: true,

  /**
   * The authentication guard to use for your application.
   */
  default: 'api',

  /**
   * The authentication guards available for your application.
   */
  guards: {
    api: {
      driver: 'token',
      provider: 'users',
    },
  },

  /**
   * The authentication providers available for your application.
   */
  providers: {
    users: {
      driver: 'database',
      table: 'users',
    },
  },

  /**
   * The username field used for authentication.
   */
  username: env.AUTH_USERNAME_FIELD || 'email',

  /**
   * The password field used for authentication.
   */
  password: env.AUTH_PASSWORD_FIELD || 'password',

  /**
   * Access-token expiry in milliseconds (default: 24 hours).
   *
   * This value IS the browser session length, not just an API-bearer TTL.
   * LoginAction mirrors the issued access token into the HttpOnly
   * `auth-token` cookie (see Actions/Auth/authCookie.ts) because the
   * dashboard is server-rendered stx with no client hydration and has no
   * other way to know who is asking. Both the cookie's Max-Age and the
   * `oauth_access_tokens.expires_at` row are stamped from here, and
   * nothing extends either one — `getUserFromToken` bumps `updated_at` on
   * every request but leaves `expires_at` alone, then deletes the row
   * once it passes. So a signed-in operator is logged out exactly this
   * long after login regardless of activity, mid-click.
   *
   * It was 1 hour, which is a sane API-bearer TTL and a hostile session.
   * The comment here used to justify that by pointing at the refresh
   * token below — but that flow does not exist (see `refreshTokenExpiry`),
   * so the short TTL bought a shorter leaked-bearer window at the cost of
   * hourly re-logins and nothing else.
   */
  tokenExpiry: env.AUTH_TOKEN_EXPIRY || 24 * 60 * 60 * 1000,

  /**
   * Refresh-token expiry in milliseconds (default: 30 days).
   *
   * NOT WIRED UP. A refresh token is minted and returned in the login
   * response body by LoginAction, VerifyTwoFactorLoginAction and
   * PasskeyLoginVerifyAction — and consumed by nothing. There is no
   * refresh route in routes/api.ts and no cookie stores it, so the value
   * below only bounds a row in `oauth_refresh_tokens` that never gets
   * read. Session length is `tokenExpiry` above, alone.
   *
   * Building the exchange is awkward here: an stx server block cannot set
   * response headers, so a server-rendered dashboard page has nowhere to
   * rotate the cookie. Anything relying on refresh needs that solved
   * first.
   */
  refreshTokenExpiry: env.AUTH_REFRESH_TOKEN_EXPIRY || 30 * 24 * 60 * 60 * 1000,

  /**
   * The token rotation time in hours (default: 24 hours).
   */
  tokenRotation: env.AUTH_TOKEN_ROTATION || 24,

  /**
   * The token abilities that are granted by default.
   */
  defaultAbilities: ['*'],

  /**
   * The token name used when creating new tokens.
   */
  defaultTokenName: 'auth-token',

  /**
   * Password reset configuration.
   */
  passwordReset: {
    /**
     * Token expiration time in minutes.
     * After this time, the reset link becomes invalid.
     *
     * @default 60
     */
    expire: env.AUTH_PASSWORD_RESET_EXPIRE ||60,

    /**
     * Throttle time in seconds between password reset requests.
     * Users must wait this long before requesting another reset email.
     *
     * @default 60
     */
    throttle: env.AUTH_PASSWORD_RESET_THROTTLE ||60,
  },
} satisfies AuthConfig
