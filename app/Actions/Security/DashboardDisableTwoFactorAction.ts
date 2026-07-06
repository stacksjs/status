import { Action } from '@stacksjs/actions'
import { Auth, disableTwoFactor, resolveAuthenticatedUser } from '@stacksjs/auth'
import { response } from '@stacksjs/router'

/**
 * `POST /security-forms/two-factor/disable` — turns TOTP off from the
 * Security settings page. Mirrors the framework DisableTwoFactorAction's
 * safety bar: disabling a second factor is exactly what a session
 * hijacker would try first, so the account password is re-confirmed
 * before anything changes.
 */
export default new Action({
  name: 'DashboardDisableTwoFactorAction',
  description: 'Disable TOTP two-factor auth from the dashboard form',

  async handle(request) {
    const user = await resolveAuthenticatedUser(request)
    if (!user || !user.email)
      return response.unauthorized('Authentication required')

    const password = String(request.get('password') ?? '')
    const confirmed = password.length > 0 && await Auth.validate({ email: user.email, password })
    if (!confirmed)
      return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?error=bad_password' } })

    await disableTwoFactor(user.id)

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?twofa=disabled' } })
  },
})
