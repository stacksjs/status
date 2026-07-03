import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '../../../config/auth-team'
import TeamMember from '../../Models/TeamMember'

/**
 * `POST /team-forms/{teamMemberId}/remove` — removes a team member (or
 * revokes a pending invite) from the dashboard (stacksjs/status#1
 * Phase 8). Deletes the TeamMember row outright rather than a soft
 * "deactivate" state — this app has no such state on TeamMember.
 *
 * Previously deleted by `id` alone with no ownership check at all — any
 * signed-in user could remove any other team's member row by guessing
 * its id. Now scoped to the requester's own team (see
 * config/auth-team.ts) — the row must belong to that team to be deleted.
 */
export default new Action({
  name: 'DashboardRemoveTeamMemberAction',
  description: 'Remove a team member or revoke a pending invite',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const id = Number(request.get('id'))
    if (id) {
      const member = await TeamMember.where('id', id).where('team_id', authTeamId).first()
      if (member) await member.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/team?team_id=${authTeamId}` } })
  },
})
