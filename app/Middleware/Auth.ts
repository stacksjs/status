import { Auth } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { HttpError } from '@stacksjs/error-handling'
import { log } from '@stacksjs/logging'
import { Middleware } from '@stacksjs/router'

export default new Middleware({
  name: 'Auth',
  priority: 1,
  async handle(request) {
    // Check bearer token first (API auth)
    const bearerToken = request.bearerToken()

    if (bearerToken) {
      log.debug(`[middleware:auth] Validating bearer token`)
      const isValid = await Auth.validateToken(bearerToken)
      if (!isValid)
        throw new HttpError(401, 'Unauthorized. Invalid token.')

      // Stamp the resolved user like the framework-default middleware does
      // (defaults/app/Middleware/Auth.ts) — `request.user()` just returns
      // `_authenticatedUser` with no fallback, so without this every
      // downstream action calling `await request.user()` (all the 2FA and
      // passkey-enrollment actions) saw undefined and 401'd even after a
      // valid token passed here. Do NOT overwrite `request.user` itself —
      // it is the accessor function (see stacksjs/stacks#1860 M-9).
      const user = await Auth.getUserFromToken(bearerToken)
      if (user) {
        Auth.setUser(user)
        ;(request as { _authenticatedUser?: unknown })._authenticatedUser = user
      }

      log.debug(`[middleware:auth] Bearer token valid`)
      return
    }

    // Check the login cookie (web auth, token driver). Plain server-rendered
    // <form method="POST"> actions — logout, and any other dashboard form on
    // an auth-guarded route — carry the HttpOnly `auth-token` cookie that
    // LoginAction sets (buildAuthCookie), but no Authorization header, so the
    // bearer check above misses them and the request 401s even though the
    // user is signed in. Validate that cookie as a token, mirroring
    // resolveTokenUser in @stacksjs/auth's team helper so every
    // cookie-authenticated entry point behaves identically. This is distinct
    // from the session_id branch below, which only applies to the `session`
    // guard driver.
    const tokenCookieName = config.auth?.defaultTokenName || 'auth-token'
    const cookieToken = request.cookie(tokenCookieName)

    if (cookieToken) {
      log.debug(`[middleware:auth] Validating login cookie`)
      const user = await Auth.getUserFromToken(cookieToken)
      if (!user)
        throw new HttpError(401, 'Unauthorized. Invalid or expired session.')

      Auth.setUser(user)
      ;(request as { _authenticatedUser?: unknown })._authenticatedUser = user

      log.debug(`[middleware:auth] Login cookie valid`)
      return
    }

    // Check session cookie (web auth)
    const sessionId = request.cookie('session_id')

    if (sessionId) {
      log.debug(`[middleware:auth] Validating session`)
      const { sessionCheck, sessionUser } = await import('@stacksjs/auth')
      const isValid = await sessionCheck(sessionId)
      if (!isValid)
        throw new HttpError(401, 'Unauthorized. Session expired.')

      // Same stamping for the session branch.
      const user = await sessionUser(sessionId)
      if (user) {
        Auth.setUser(user)
        ;(request as { _authenticatedUser?: unknown })._authenticatedUser = user
      }

      log.debug(`[middleware:auth] Session valid`)
      return
    }

    throw new HttpError(401, 'Unauthorized. No token or session provided.')
  },
})
