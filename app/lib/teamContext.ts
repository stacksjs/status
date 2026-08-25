import { resolveAuthenticatedTeamId, resolveAuthenticatedUser } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'

/**
 * Resolve the caller's team, creating their personal one if they somehow
 * do not have it.
 *
 * Every dashboard action is team-scoped and used to call
 * `resolveAuthenticatedTeamId` directly, 401ing when it came back null. That
 * conflates two unrelated states: "no valid session" and "signed in, but
 * belongs to no team". The second is not the user's fault and is not
 * something they can fix from the UI -- there is no "create a team" screen --
 * so a perfectly valid session got told "Authentication required" on every
 * write, forever.
 *
 * RegisterAction does try to create a personal team at signup, but inside a
 * best-effort try/catch that only logs. When that attempt fails the account
 * is permanently inert: it can sign in, load the dashboard, read the empty
 * lists, and mutate nothing. That was reproduced on production against a
 * freshly registered account while the identical code path succeeded locally,
 * so the cause is environmental and not something a code read will settle.
 *
 * Rather than guess at it, this repairs the state where it is noticed. A
 * signed-in user without a team gets one here, which also heals accounts
 * already broken by an earlier failed signup -- no database surgery, no
 * migration, they just work on their next action.
 *
 * Returns null ONLY when there is genuinely no session. Callers can therefore
 * treat null as "not signed in" and say so honestly.
 */
/**
 * Why a caller has no team, for callers that need to say something honest.
 *
 * `no_session` is the only one that means "sign in". `team_unavailable` means
 * the session is fine and we could not give them a workspace — a server-side
 * problem, and emphatically not something the user can fix by logging in
 * again, which is exactly what the old blanket 401 told them to do.
 */
export type TeamFailure = 'no_session' | 'team_unavailable'

export async function resolveTeamOrFailure(request: unknown): Promise<number | TeamFailure> {
  const existing = await resolveAuthenticatedTeamId(request as never)
  if (existing)
    return existing

  const user = await resolveAuthenticatedUser(request as never)
  if (!user?.id)
    return 'no_session'

  const named = user as { name?: unknown }
  const created = await createPersonalTeam(Number(user.id), String(named.name ?? ''), String(user.email ?? ''))

  return created ?? 'team_unavailable'
}

export async function resolveOrCreateTeamId(request: unknown): Promise<number | null> {
  const existing = await resolveAuthenticatedTeamId(request as never)
  if (existing)
    return existing

  const user = await resolveAuthenticatedUser(request as never)
  if (!user?.id)
    return null

  // `name` is on the row but absent from the resolver's declared return type,
  // so read it defensively rather than widening the framework's type.
  const named = user as { name?: unknown }

  return createPersonalTeam(Number(user.id), String(named.name ?? ''), String(user.email ?? ''))
}

/**
 * Create a user's own team and the membership that makes it resolvable.
 *
 * Shared with RegisterAction so signup and this repair path cannot drift into
 * producing differently-shaped teams.
 *
 * Deliberately writes ONLY the columns the app reads. An earlier version also
 * set `teams.user_id` and `teams.owner` through `forceCreate` (they sit
 * outside the model's fillable allowlist), which records ownership on the team
 * row -- but nothing resolves ownership from there. The dashboard reads the
 * `team_members` row below, and those two columns are the ones most likely to
 * differ between environments, since they are the ones the model does not
 * declare. Writing less is the safer bet while the production failure is
 * still unexplained.
 */
export async function createPersonalTeam(userId: number, name: string, email: string): Promise<number | null> {
  try {
    const teamName = name.trim() ? `${name.trim()}'s Team` : 'My Team'
    const now = new Date().toISOString()

    await db.insertInto('teams').values({ name: teamName, status: 'active' }).execute()

    // Read back rather than trusting a returned id: the dialect differs
    // between the self-hosted SQLite and the hosted Postgres, and this runs
    // on both.
    const created = await db
      .selectFrom('teams')
      .where('name', '=', teamName)
      .orderBy('id', 'desc')
      .select(['id'])
      .executeTakeFirst()

    if (!created?.id) {
      log.error(`[teamContext] created a team for user#${userId} and could not read it back`)
      return null
    }

    const teamId = Number(created.id)

    await db.insertInto('team_members').values({
      team_id: teamId,
      user_id: userId,
      invited_email: email,
      role: 'owner',
      status: 'active',
      invited_at: now,
      joined_at: now,
    }).execute()

    log.info(`[teamContext] created team#${teamId} for user#${userId}`)
    return teamId
  }
  catch (err) {
    // Loud, and with the reason attached. The old call site swallowed this
    // into a bare console.error, which is why the production failure went
    // unexplained for as long as it did.
    log.error(`[teamContext] failed to create a team for user#${userId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
