import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { Team, User } from '@stacksjs/orm'
import TeamMember from '../../Models/TeamMember'
import { buildAuthCookie } from '../Auth/authCookie'

/**
 * Browser-facing team-invite acceptance: `POST /invite-forms/{uuid}/accept`,
 * the plain-form counterpart to the JSON AcceptTeamInviteAction. This is
 * what the link in the invite email lands on (via resources/views/invite/
 * [uuid].stx), so a real person can join a team without an API client.
 *
 * The invite uuid is the capability: it names the pending membership and
 * its invited_email. One form handles both cases:
 *   - the email already has an account -> verify the submitted password
 *     (Auth.attempt) and link that user,
 *   - no account yet -> register one with the submitted name + password.
 * Either way the membership flips to active and a session cookie is
 * minted, so acceptance lands the teammate straight in the dashboard.
 *
 * Every failure redirects back to /invite/{uuid}?error=... rather than
 * returning JSON, because this backs a full-page browser form.
 */
export default new Action({
  name: 'AcceptInviteFormAction',
  description: 'Accept a team invite from the browser and sign in',
  method: 'POST',

  async handle(request: RequestInstance) {
    const uuid = String(request.get('uuid') ?? '')
    const back = (err: string) => new Response(null, { status: 302, headers: { Location: `/invite/${encodeURIComponent(uuid)}?error=${err}` } })

    if (!uuid)
      return new Response(null, { status: 302, headers: { Location: '/login' } })

    const member = await TeamMember.where('uuid', uuid).first()
    // Only a still-pending invite can be accepted. A missing or already
    // active/declined membership must not be re-linkable via a leaked uuid.
    if (!member || member.status !== 'pending')
      return back('invalid')

    const email = String(member.invited_email ?? '').toLowerCase()
    if (!email)
      return back('invalid')

    const name = String(request.get('name') ?? '').trim()
    const password = String(request.get('password') ?? '')
    if (password.length < 6)
      return back('weak_password')

    // Resolve the accepting user: an existing account (password-verified)
    // or a freshly registered one.
    let userId: number | null = null
    const existing = await User.where('email', email).first()
    if (existing) {
      const ok = await Auth.attempt({ email, password })
      if (!ok)
        return back('bad_credentials')
      userId = existing.id as number
    }
    else {
      if (name.length < 2)
        return back('name_required')
      const result = await register({ email, name, password })
      if (!result)
        return back('register_failed')
      const created = await User.where('email', email).first()
      if (!created)
        return back('register_failed')
      userId = created.id as number
      dispatch('user:registered', { id: userId, email, name, to: email })
    }

    // Link the membership and activate it (framework Team + TeamMember).
    await member.update({ user_id: userId, status: 'active', joined_at: new Date().toISOString() })

    // Keep teams.member_count honest for the settings page readout.
    try {
      const team = await Team.find(member.team_id)
      if (team) {
        const active = await TeamMember.where('team_id', member.team_id).where('status', 'active').get()
        await Team.forceUpdate(member.team_id, { member_count: active.length })
      }
    }
    catch {
      // best-effort: a stale count must not block the accept
    }

    // Mint the same HttpOnly cookie session the dashboard reads during SSR,
    // so the teammate lands signed in.
    const session = await Auth.loginUsingId(userId)
    if (!session)
      return new Response(null, { status: 302, headers: { Location: '/login?accepted=1' } })

    return new Response(null, {
      status: 302,
      headers: { 'Location': '/dashboard', 'Set-Cookie': buildAuthCookie(session.token, session.expiresIn) },
    })
  },
})
