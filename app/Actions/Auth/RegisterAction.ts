import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { dispatch } from '@stacksjs/events'
import { Auth, register } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import TeamMember from '../../Models/TeamMember'
import { buildAuthCookie } from './authCookie'
import { createPersonalTeam } from '../../lib/teamContext'

/**
 * Project override of the framework's default RegisterAction (registered
 * in routes/api.ts, which wins over storage/framework/defaults/routes/
 * dashboard.ts's copy — user routes load first).
 *
 * Identical registration flow to the framework default, with one
 * addition: on success the issued bearer is also mirrored into an
 * HttpOnly cookie, exactly like LoginAction. Without this a just-
 * registered user has a token in localStorage but no cookie, so the
 * server-rendered dashboard (resources/views/dashboard/*.stx) can't
 * resolve them during SSR and the post-signup redirect lands on a
 * "you need to sign in" empty state. See Actions/Auth/authCookie.ts.
 */
export default new Action({
  name: 'RegisterAction',
  description: 'Register a new user',
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
    name: {
      rule: schema.string().min(2).max(255),
      message: 'Name must be between 2 and 255 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const email = request.get('email')
    const password = request.get('password')
    const name = request.get('name')

    const result = await register({ email, password, name })

    if (result) {
      const user = await Auth.getUserFromToken(result.token)

      // Give the new user a team to own — without one the dashboard
      // (which scopes everything to team_members) shows a dead
      // "no team" state and CreateMonitorAction has nothing to attach
      // to. registration doesn't create a team by default, so the
      // post-signup "Get started" flow would otherwise land nowhere.
      //
      // Still best-effort: the account and token already exist, and failing
      // the whole registration over the team would be worse. What changed is
      // that failing here is no longer terminal — resolveOrCreateTeamId
      // retries on the user's next action, so a hiccup costs a moment rather
      // than permanently laming the account. Shared helper so signup and that
      // repair path cannot produce differently-shaped teams.
      if (user?.id) {
        const existingMembership = await TeamMember.where('user_id', user.id).where('status', 'active').first()
        if (!existingMembership)
          await createPersonalTeam(Number(user.id), String(name ?? ''), String(user.email ?? ''))
      }

      // Fire `user:registered` so app/Events.ts listeners (welcome email,
      // CRM sync, internal slack ping, etc.) actually run. Fire-and-forget
      // — listener errors are caught by the wildcard handler so a flaky
      // welcome email doesn't fail registration. The `to` alias matches
      // the contract SendWelcomeEmail expects.
      dispatch('user:registered', {
        id: user?.id,
        email: user?.email,
        name: user?.name,
        to: user?.email,
      })

      return response.json(
        {
          token: result.token,
          user: {
            id: user?.id,
            email: user?.email,
            name: user?.name,
          },
        },
        { status: 200, headers: { 'Set-Cookie': buildAuthCookie(result.token) } },
      )
    }

    return response.error('Registration failed')
  },
})
