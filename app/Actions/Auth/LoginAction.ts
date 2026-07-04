import process from 'node:process'
import { createTwoFactorChallenge, getTwoFactorState } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { User } from '@stacksjs/orm'

/**
 * Project override of the framework's default LoginAction (registered
 * in routes/api.ts, which wins over storage/framework/defaults/routes/
 * dashboard.ts's copy — user routes load first).
 *
 * Identical credential/2FA flow to the framework default, with one
 * addition: on success, the issued bearer is also mirrored into an
 * HttpOnly `config.auth.defaultTokenName` cookie. The SPA's `useAuth`
 * composable only ever stores the bearer in localStorage, which is
 * invisible during server-side rendering — the dashboard's `.stx` pages
 * (server-rendered directly from SQLite, no client hydration) need a
 * cookie to resolve "who's logged in" and scope data to their team. See
 * resources/views/dashboard/*.stx's auth+team resolution block.
 */
export default new Action({
  name: 'LoginAction',
  description: 'Login to the application',
  method: 'POST',

  validations: {
    email: {
      rule: schema.string().email(),
      message: 'Email must be a valid email address.',
    },
    password: {
      rule: schema.string().min(6).max(255),
      message: 'Password must be between 6 and 255 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const email = request.get('email')
    const password = request.get('password')

    // Verify credentials WITHOUT minting tokens yet — if the account
    // has TOTP 2FA enabled, no token pack should exist until the code
    // is also verified.
    const isValid = await Auth.attempt({ email, password })
    if (!isValid)
      return response.unauthorized('Incorrect email or password')

    const authedUser = await User.where('email', '=', email).first()
    if (!authedUser)
      return response.unauthorized('Incorrect email or password')

    const { enabled: twoFactorEnabled } = await getTwoFactorState(authedUser.id as number)
    if (twoFactorEnabled) {
      const challengeToken = await createTwoFactorChallenge(authedUser.id as number)
      return response.json({
        requires_two_factor: true,
        challenge_token: challengeToken,
      })
    }

    const result = await Auth.loginUsingId(authedUser.id as number)
    if (!result)
      return response.unauthorized('Incorrect email or password')

    const user = result.user

    return response.json(
      {
        access_token: result.token,
        refresh_token: result.refreshToken,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        token: result.token,
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
        },
      },
      { status: 200, headers: { 'Set-Cookie': buildAuthCookie(result.token, result.expiresIn) } },
    )
  },
})

function buildAuthCookie(token: string, expiresInSeconds?: number): string {
  const name = config.auth?.defaultTokenName || 'auth-token'
  const maxAge = Math.max(1, Math.floor(expiresInSeconds ?? (config.auth?.tokenExpiry ?? 60 * 60 * 1000) / 1000))
  const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase()
  const isLocal = env === '' || env === 'local' || env === 'development' || env === 'dev' || env === 'test' || env === 'testing'

  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (!isLocal)
    parts.push('Secure')

  return parts.join('; ')
}
