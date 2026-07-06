import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { Team } from '@stacksjs/orm'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import TeamMember from '../../Models/TeamMember'
import { buildAuthCookie } from './authCookie'

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
      // Best-effort: a team-creation hiccup must not fail the whole
      // registration (the account + token already exist).
      if (user?.id) {
        try {
          const existingMembership = await TeamMember.where('user_id', user.id).where('status', 'active').first()
          if (!existingMembership) {
            const teamName = name ? `${name}'s Team` : 'My Team'
            // forceCreate: `owner`/`user_id` aren't in the Team model's
            // fillable allowlist (only name/description/memberCount/status
            // are), but the columns exist and recording ownership on the
            // team row itself is correct. The dashboard resolves the active
            // team via the team_members row below, not these columns.
            const team = await Team.forceCreate({
              name: teamName,
              status: 'active',
              user_id: user.id,
              owner: user.email,
            })

            await TeamMember.create({
              team_id: team.id,
              user_id: user.id,
              role: 'owner',
              status: 'active',
              joined_at: new Date().toISOString(),
            })
          }
        }
        catch (err) {
          console.error('[RegisterAction] failed to create default team', err)
        }
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
        { status: 200, headers: { 'Set-Cookie': buildAuthCookie(result.token, result.expiresIn) } },
      )
    }

    return response.error('Registration failed')
  },
})
