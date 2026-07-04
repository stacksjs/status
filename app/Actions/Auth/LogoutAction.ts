import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { response } from '@stacksjs/router'

/**
 * Project override of the framework's default LogoutAction — same
 * token revocation, plus clearing the HttpOnly auth cookie LoginAction
 * sets (see its doc comment for why the cookie exists at all).
 */
export default new Action({
  name: 'LogoutAction',
  description: 'Logout from the application',
  method: 'POST',
  async handle() {
    await Auth.logout()

    return response.json(
      { message: 'Successfully logged out' },
      { status: 200, headers: { 'Set-Cookie': clearAuthCookie() } },
    )
  },
})

function clearAuthCookie(): string {
  const name = config.auth?.defaultTokenName || 'auth-token'
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
