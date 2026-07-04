import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth, sessionUser } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import Team from '../../../storage/framework/defaults/app/Models/Team'

const VALID_FREQUENCIES = ['none', 'weekly', 'monthly']
const MAX_RECIPIENTS = 10
// Deliberately loose: local part, an @, a domain with at least one dot.
// Real validation is the mail transport's job; this only keeps garbage
// out of the column.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * `POST /team-forms/{id}/report-settings` updates the team's periodic
 * uptime report settings (report_frequency + report_recipients, see
 * migration 0000000195 and app/Jobs/SendUptimeReports.ts) from the
 * dashboard's native HTML form on /dashboard/settings/team. Same
 * plain-POST, redirect-back convention as its siblings
 * (DashboardInviteTeamMemberAction / DashboardRemoveTeamMemberAction).
 *
 * Auth follows the same driver-aware credential resolution as
 * config/auth-team.ts's resolveAuthenticatedTeamId (never a
 * client-supplied field), but is resolved locally because this action
 * also needs the requester's ROLE: unlike invites, report settings are
 * restricted to active owner/admin members. Team precedence (owner over
 * admin over member) matches the shared helper exactly so the team this
 * action writes to is always the team the page rendered.
 */
export default new Action({
  name: 'DashboardUpdateReportSettingsAction',
  description: 'Update a team\'s uptime report settings from a dashboard form',

  async handle(request) {
    const membership = await resolveAuthenticatedMembership(request)
    if (!membership)
      return response.unauthorized('Authentication required')

    const authTeamId = membership.teamId

    // Same route-param parity check as DashboardInviteTeamMemberAction:
    // the {id} param is never trusted as the team to write to, only
    // compared against the team derived from the requester's credential.
    const requestedTeamId = Number(request.get('id'))
    if (requestedTeamId && requestedTeamId !== authTeamId)
      return response.forbidden('You do not have access to this team')

    // Only owners and admins may change report settings.
    if (membership.role !== 'owner' && membership.role !== 'admin')
      return response.forbidden('Only team owners and admins can change report settings')

    const frequency = String(request.get('report_frequency') ?? 'none').trim().toLowerCase()
    const recipientsRaw = String(request.get('report_recipients') ?? '').trim()
    const recipients = recipientsRaw
      ? recipientsRaw.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)
      : []

    const valid = VALID_FREQUENCIES.includes(frequency)
      && recipients.length <= MAX_RECIPIENTS
      && recipients.every(entry => EMAIL_RE.test(entry))

    // Invalid input is a silent no-op redirect, same behavior as the
    // sibling form actions (nothing persists, the page re-renders with
    // the stored values).
    if (valid) {
      // forceUpdate: the built-in Team model's fillable list is only
      // name/description/memberCount/status (see RegisterAction's
      // forceCreate note), so the report columns need the escape hatch.
      // Empty recipients stores NULL, which means "send to the team owner"
      // (teams.owner) in SendUptimeReports.
      await Team.forceUpdate(authTeamId, {
        report_frequency: frequency,
        report_recipients: recipients.length > 0 ? recipients.join(', ') : null,
      })
    }

    // Preserve the team context on the way back, same as the siblings.
    return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/team?team_id=${authTeamId}` } })
  },
})

/**
 * Copy of config/auth-team.ts's resolution logic, extended to also
 * return the role of the membership that won the owner > admin > member
 * precedence. Kept here (not in the shared helper) so the shared
 * signature other actions depend on stays untouched.
 */
async function resolveAuthenticatedMembership(request: RequestInstance): Promise<{ teamId: number, role: string } | null> {
  const guardName = config.auth?.default || 'api'
  const guard = config.auth?.guards?.[guardName] || { driver: 'token' }
  const driver = guard.driver || 'token'

  const user = driver === 'session'
    ? await resolveSessionUser(request)
    : await resolveTokenUser(request)

  if (!user?.id)
    return null

  const memberships = await db
    .selectFrom('team_members')
    .where('user_id', '=', user.id)
    .where('status', '=', 'active')
    .select(['team_id', 'role'])
    .execute()

  if (memberships.length === 0)
    return null

  const owner = memberships.find(m => m.role === 'owner')
  const admin = memberships.find(m => m.role === 'admin')
  const membership = owner ?? admin ?? memberships[0]

  return { teamId: Number(membership.team_id), role: String(membership.role) }
}

async function resolveSessionUser(request: RequestInstance) {
  const sessionId = request.cookies?.get('session_id')
  if (!sessionId)
    return undefined

  return sessionUser(sessionId)
}

async function resolveTokenUser(request: RequestInstance) {
  const cookieName = config.auth?.defaultTokenName || 'auth-token'
  const bearer = request.bearerToken() ?? request.cookies?.get(cookieName)
  if (!bearer)
    return undefined

  return Auth.getUserFromToken(bearer)
}
