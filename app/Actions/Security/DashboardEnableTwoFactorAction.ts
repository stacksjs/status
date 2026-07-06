import { Action } from '@stacksjs/actions'
import { consumePendingTwoFactorSecret, enableTwoFactor, resolveAuthenticatedUser } from '@stacksjs/auth'
import { response } from '@stacksjs/router'

/**
 * `POST /security-forms/two-factor/enable` — confirms TOTP setup from the
 * Security settings page (stacksjs/status#1 Phase 9 follow-up: the 2FA
 * dashboard UI that was deferred until real dashboard auth existed).
 *
 * Plain-POST, redirect-back counterpart to the framework's JSON
 * EnableTwoFactorAction, same shape as the other dashboard form actions.
 * The secret is NEVER taken from the client: the Security page stashed it
 * server-side when it rendered the setup step
 * (stashPendingTwoFactorSecret, 10 minute TTL, delete-on-read), so this
 * action only needs the 6-digit code to verify against the stash.
 */
export default new Action({
  name: 'DashboardEnableTwoFactorAction',
  description: 'Enable TOTP two-factor auth from the dashboard form',

  async handle(request) {
    const user = await resolveAuthenticatedUser(request)
    if (!user)
      return response.unauthorized('Authentication required')

    const code = String(request.get('code') ?? '').trim()
    if (!/^\d{6}$/.test(code))
      return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?setup=1&error=invalid_code' } })

    const pendingSecret = await consumePendingTwoFactorSecret(user.id)
    if (!pendingSecret)
      return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?error=setup_expired' } })

    const enabled = await enableTwoFactor(user.id, pendingSecret, code)
    if (!enabled)
      return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?error=invalid_code' } })

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?twofa=enabled' } })
  },
})
