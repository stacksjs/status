import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import SendTeamInviteEmail from '../../Jobs/SendTeamInviteEmail'
import TeamMember from '../../Models/TeamMember'

/**
 * `POST /teams/:id/invite` — creates a pending TeamMember row by email
 * (stacksjs/status#1 Phase 9) and emails the invited address their
 * acceptance token (the invite `uuid`, consumed by
 * `POST /team-invites/{uuid}/accept`). Only one pending/active membership
 * per (team, email) — inviting an already-invited address returns the
 * existing row rather than creating a duplicate, and does NOT re-send
 * the email.
 */
export default new Action({
  name: 'InviteTeamMemberAction',
  description: 'Invite a user to a team by email',

  async handle(request) {
    const teamId = Number(request.get('id'))
    const email = String(request.get('email') ?? '').trim().toLowerCase()
    const role = String(request.get('role') ?? 'member')

    if (!teamId)
      return response.json({ error: 'team id is required' }, { status: 422 })
    if (!email)
      return response.json({ error: 'email is required' }, { status: 422 })
    if (!['owner', 'admin', 'member'].includes(role))
      return response.json({ error: `invalid role '${role}'` }, { status: 422 })

    const existing = await TeamMember.where('team_id', teamId).where('invited_email', email).first()
    if (existing)
      return response.json(existing, { status: 200 })

    const member = await TeamMember.create({
      team_id: teamId,
      invited_email: email,
      role,
      status: 'pending',
      invited_at: new Date().toISOString(),
    })

    await SendTeamInviteEmail.dispatch({ email, teamId, role, inviteUuid: member.uuid })

    return response.json(member, { status: 201 })
  },
})
