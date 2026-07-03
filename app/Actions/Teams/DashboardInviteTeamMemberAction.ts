import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '../../../config/auth-team'
import SendTeamInviteEmail from '../../Jobs/SendTeamInviteEmail'
import TeamMember from '../../Models/TeamMember'

/**
 * `POST /team-forms/{id}/invite` — a plain-POST, redirect-back
 * counterpart to Actions/Teams/InviteTeamMemberAction, for the
 * dashboard's native HTML form (stacksjs/status#1 Phase 8; see
 * Actions/StatusPages/UpdateStatusPageAction for why dashboard forms
 * are plain POST instead of client JS). Same dedup-by-email behavior as
 * the JSON action: inviting an already-invited address is a no-op, not
 * a duplicate row.
 *
 * The `{id}` route param used to be trusted outright as the team to
 * invite into — any signed-in user could invite into any team by
 * posting a different id. The team is now derived from the requester's
 * own session/token (see config/auth-team.ts); the route param is only
 * checked for parity with it.
 */
export default new Action({
  name: 'DashboardInviteTeamMemberAction',
  description: 'Invite a team member from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const requestedTeamId = Number(request.get('id'))
    if (requestedTeamId && requestedTeamId !== authTeamId)
      return response.forbidden('You do not have access to this team')

    const email = String(request.get('email') ?? '').trim().toLowerCase()
    const role = String(request.get('role') ?? 'member')

    if (email && ['owner', 'admin', 'member'].includes(role)) {
      const existing = await TeamMember.where('team_id', authTeamId).where('invited_email', email).first()
      if (!existing) {
        const member = await TeamMember.create({
          team_id: authTeamId,
          invited_email: email,
          role,
          status: 'pending',
          invited_at: new Date().toISOString(),
        })

        // Best-effort, same as InviteTeamMemberAction — the row exists;
        // a sync-driver mail failure must not break the form redirect.
        await SendTeamInviteEmail.dispatch({ email, teamId: authTeamId, role, inviteUuid: member.uuid }).catch(() => {})
      }
    }

    // Preserve the team context on the way back (same as
    // DashboardRemoveTeamMemberAction) — a bare redirect lands on
    // team.stx's TEAM_ID default of 1, silently switching teams.
    return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/team?team_id=${authTeamId}` } })
  },
})
