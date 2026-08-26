import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import TeamMember from '../../Models/TeamMember'
import { requireTeamId } from '../../lib/teamGuard'

/** The roles the invite form already offers, and the only ones accepted here. */
const ROLES = new Set(['owner', 'admin', 'member'])

/**
 * `POST /team-forms/{teamMemberId}/role` — change an existing member's role.
 *
 * The roster rendered `role` as plain text, so the only way to promote or
 * demote anyone was to remove them and send a fresh invite — which for an
 * already-active member means revoking their access and asking them to accept
 * again, to change one word.
 *
 * Scoped to the requester's own team from the session, like the remove action
 * beside it: passing an id alone must never be enough to touch another team's
 * roster.
 *
 * Demoting the last owner is refused. Roles are the only thing standing
 * between a team and nobody being able to administer it, and an accidental
 * self-demotion is unrecoverable from inside the product — there is no
 * "contact support" screen to climb back out through.
 */
export default new Action({
  name: 'DashboardUpdateTeamMemberRoleAction',
  description: 'Change a team member\'s role from the dashboard',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const id = Number(request.get('id'))
    const role = String(request.get('role') ?? '')
    const back = (error?: string) => new Response(null, {
      status: 302,
      headers: { Location: `/dashboard/settings/team?team_id=${authTeamId}${error ? `&error=${error}` : '&saved=1'}` },
    })

    if (!id || !ROLES.has(role))
      return back('bad_role')

    const member = await TeamMember.where('id', id).where('team_id', authTeamId).first()
    if (!member)
      return response.forbidden('You do not have access to this team member')

    if (member.role === role)
      return back()

    if (member.role === 'owner') {
      // Count owners rather than checking "is this me": an owner demoting a
      // co-owner is fine, and an owner demoting themselves is fine too — as
      // long as somebody is still left holding the keys.
      const owners = await TeamMember.where('team_id', authTeamId).where('role', 'owner').get()
      if (owners.length <= 1)
        return back('last_owner')
    }

    await member.update({ role })

    return back()
  },
})
