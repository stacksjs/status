import type { RequestInstance } from '@stacksjs/types'
import { Auth, sessionUser } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'

/**
 * Resolve the requesting user's team_id from their real auth credential
 * (bearer token or session cookie) — never from a client-supplied form
 * field. Driver-aware, same as the dashboard's server-rendered `.stx`
 * pages' `resolveAuthTeam` (see resources/views/dashboard/monitors/
 * index.stx) — reads config/auth.ts's configured guard driver rather
 * than hardcoding a validation scheme.
 *
 * Dashboard forms are plain HTML POSTs (no client JS, no Authorization
 * header) — the browser only ever sends the auth cookie LoginAction
 * sets on login, so that's checked first for the 'token' driver, with
 * a bearer-header fallback for any JS/API caller.
 *
 * Owner membership wins over admin, which wins over any other active
 * membership, when a user belongs to more than one team — same
 * precedence as the `.stx` pages so a user never sees a different
 * "current team" between the page that rendered a form and the action
 * that form posts to.
 *
 * Returns `null` when unauthenticated or without an active team
 * membership — callers must treat that as "reject the request," not
 * "fall back to a default team."
 */
export async function resolveAuthenticatedTeamId(request: RequestInstance): Promise<number | null> {
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

  return Number((owner ?? admin ?? memberships[0]).team_id)
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
