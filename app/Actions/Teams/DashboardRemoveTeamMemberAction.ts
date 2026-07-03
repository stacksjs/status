import { Action } from '@stacksjs/actions'
import TeamMember from '../../Models/TeamMember'

/**
 * `POST /team-forms/{teamMemberId}/remove` — removes a team member (or
 * revokes a pending invite) from the dashboard (stacksjs/status#1
 * Phase 8). Deletes the TeamMember row outright rather than a soft
 * "deactivate" state — this app has no such state on TeamMember.
 */
export default new Action({
  name: 'DashboardRemoveTeamMemberAction',
  description: 'Remove a team member or revoke a pending invite',

  async handle(request) {
    const id = Number(request.get('id'))
    const teamId = request.get('team_id')

    if (id) {
      const member = await TeamMember.find(id)
      if (member) await member.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/team?team_id=${teamId ?? ''}` } })
  },
})
