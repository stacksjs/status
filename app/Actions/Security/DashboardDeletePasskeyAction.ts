import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedUser } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'

/**
 * `POST /security-forms/passkeys/delete` — removes one of the
 * requester's OWN passkeys from the Security settings page. The delete
 * is scoped by (id, user_id) so a signed-in user can't remove another
 * account's credential by guessing its id — same ownership-scoping
 * pattern as DashboardRemoveTeamMemberAction. The passkeys table is
 * framework-managed (auth-tables.ts, no model), so this uses raw db
 * access like the auth core does.
 */
export default new Action({
  name: 'DashboardDeletePasskeyAction',
  description: 'Delete one of the requester\'s passkeys from the dashboard form',

  async handle(request) {
    const user = await resolveAuthenticatedUser(request)
    if (!user)
      return response.unauthorized('Authentication required')

    const id = String(request.get('id') ?? '')
    if (id) {
      await db.deleteFrom('passkeys')
        .where('id', '=', id)
        .where('user_id', '=', user.id)
        .execute()
    }

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/security?passkey=removed' } })
  },
})
