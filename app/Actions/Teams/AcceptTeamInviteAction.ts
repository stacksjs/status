import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import TeamMember from '../../Models/TeamMember'

/**
 * `POST /team-invites/:uuid/accept` — links the invited email to a real
 * user account and flips the membership to 'active' (stacksjs/status#1
 * Phase 9). Takes `user_id` explicitly in the payload rather than reading
 * it off a session, matching how the rest of this app (e.g.
 * CreateMonitorAction's `team_id`) predates the Phase 9 auth-session
 * wiring — once that lands, the caller becomes "the currently
 * authenticated user" instead of a passed field, with no change needed
 * here.
 */
export default new Action({
  name: 'AcceptTeamInviteAction',
  description: 'Accept a pending team invite',

  async handle(request) {
    const uuid = request.get('uuid')
    const userId = Number(request.get('user_id'))

    if (!uuid)
      return response.json({ error: 'invite uuid is required' }, { status: 422 })
    if (!userId)
      return response.json({ error: 'user_id is required' }, { status: 422 })

    const member = await TeamMember.where('uuid', uuid).first()
    if (!member)
      return response.json({ error: 'invite not found' }, { status: 404 })

    if (member.status === 'active')
      return response.json(member, { status: 200 })

    await member.update({ user_id: userId, status: 'active', joined_at: new Date().toISOString() })
    return response.json(await TeamMember.find(member.id), { status: 200 })
  },
})
