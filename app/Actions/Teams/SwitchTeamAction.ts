import process from 'node:process'
import { Action } from '@stacksjs/actions'
import { buildActiveTeamCookie, clearActiveTeamCookie, resolveTeamContext } from '@stacksjs/auth'

/**
 * `POST /team-forms/switch` — the workspace switcher. Pins the active team the
 * dashboard scopes to (an account can belong to many teams; super-admins can
 * switch to any). The selection is a cookie, but the server re-validates it on
 * every request via @stacksjs/auth's selectActiveTeam, so this only accepts a
 * team the requester may actually access — a tampered team_id is ignored.
 *
 * Plain form post + redirect (no JSON), same convention as the other
 * /team-forms/* actions; it redirects back to wherever the switcher was used.
 */
export default new Action({
  name: 'SwitchTeamAction',
  description: 'Switch the active team (workspace) for the dashboard',
  method: 'POST',

  async handle(request: RequestInstance) {
    // resolveTeamContext yields the teams this user may switch to — their own
    // memberships, or every team for a super-admin (allowAnyTeam).
    const ctx = await resolveTeamContext(request, { allowAnyTeam: u => !!(u && u.is_super_admin) })
    if (!ctx.user)
      return new Response(null, { status: 302, headers: { Location: '/login' } })

    // Only same-origin, absolute-path redirects — never an open redirect.
    const rawBack = String(request.get('redirect') ?? '/dashboard')
    const back = rawBack.startsWith('/') && !rawBack.startsWith('//') ? rawBack : '/dashboard'

    const env = (process.env.APP_ENV ?? process.env.NODE_ENV ?? '').toLowerCase()
    const isLocal = ['', 'local', 'development', 'dev', 'test', 'testing'].includes(env)

    // "All teams" / clear: drops the pin. For a super-admin that restores the
    // cross-team view; for a normal member it falls back to their default team.
    const raw = String(request.get('team_id') ?? '').trim()
    if (raw === '' || raw === '0' || raw === 'all') {
      return new Response(null, { status: 302, headers: { 'Location': back, 'Set-Cookie': clearActiveTeamCookie() } })
    }

    const target = Number(raw)
    const allowed = Number.isFinite(target) && ctx.teams.some(t => t.id === target)
    if (!allowed)
      return new Response(null, { status: 302, headers: { Location: back } })

    return new Response(null, {
      status: 302,
      headers: { 'Location': back, 'Set-Cookie': buildActiveTeamCookie(target, { secure: !isLocal }) },
    })
  },
})
