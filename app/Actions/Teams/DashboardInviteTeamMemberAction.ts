import { Action } from '@stacksjs/actions'
import TeamMember from '../../Models/TeamMember'

/**
 * `POST /team-forms/{id}/invite` — a plain-POST, redirect-back
 * counterpart to Actions/Teams/InviteTeamMemberAction, for the
 * dashboard's native HTML form (stacksjs/status#1 Phase 8; see
 * Actions/StatusPages/UpdateStatusPageAction for why dashboard forms
 * are plain POST instead of client JS). Same dedup-by-email behavior as
 * the JSON action: inviting an already-invited address is a no-op, not
 * a duplicate row.
 */
export default new Action({
  name: 'DashboardInviteTeamMemberAction',
  description: 'Invite a team member from a dashboard form',

  async handle(request) {
    const teamId = Number(request.get('id'))
    const email = String(request.get('email') ?? '').trim().toLowerCase()
    const role = String(request.get('role') ?? 'member')

    if (teamId && email && ['owner', 'admin', 'member'].includes(role)) {
      const existing = await TeamMember.where('team_id', teamId).where('invited_email', email).first()
      if (!existing) {
        await TeamMember.create({
          team_id: teamId,
          invited_email: email,
          role,
          status: 'pending',
          invited_at: new Date().toISOString(),
        })
      }
    }

    return new Response(null, { status: 302, headers: { Location: '/dashboard/settings/team' } })
  },
})
