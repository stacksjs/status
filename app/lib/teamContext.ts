import { resolveAuthenticatedTeamId, resolveAuthenticatedUser, resolveTeamContext } from '@stacksjs/auth'
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
 * resolveTeamContext, but a signed-in user without a team gets one first.
 *
 * The dashboard VIEWS resolve their own context rather than going through the
 * actions, so healing only the write path left every page rendering
 * `Team -1` (the fail-closed sentinel) for an account whose signup team
 * creation had failed. The write would succeed and the page would still look
 * broken, which is indistinguishable from the write being broken too.
 *
 * Yes, this can write during a GET. That is deliberate: the alternative is a
 * dashboard that renders a dead "no team" state until the user guesses that
 * submitting a form will fix it. The write is idempotent and only fires for
 * an account that is already in a state it cannot get out of on its own.
 *
 * Re-resolves after creating so `teams`, `role` and the switcher list come
 * back populated rather than hand-assembled here.
 */
export async function resolveHealedTeamContext(request: unknown, opts?: unknown): Promise<TeamContext> {
  const ctx = await resolveTeamContext(request as never, opts as never) as TeamContext

  if (!ctx?.user || ctx.teamId != null)
    return ctx

  const user = ctx.user as { id?: unknown, name?: unknown, email?: unknown }
  if (!user.id)
    return ctx

  const created = await createPersonalTeam(Number(user.id), String(user.name ?? ''), String(user.email ?? ''))
  if (created == null)
    return ctx

  return await resolveTeamContext(request as never, opts as never) as TeamContext
}

/** The shape the dashboard views destructure. */
interface TeamContext {
  user: unknown
  teamId: number | null
  role: string | null
  teams: Array<{ id: number, name: string, role: string }>
  activeTeamId: number | null
}

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
  // `teams.name` carries a UNIQUE index (teams_name_unique), and the name is
  // derived from the user's -- so the SECOND person called Chris collides
  // with the first, and every signup that leaves the name blank collides
  // with whoever took "My Team". That is the whole bug: signup's team
  // creation was inside a swallowing try/catch, so the collision threw, the
  // account got no team, and every later write answered "Authentication
  // required" while the session was perfectly valid.
  //
  // It hid well. The first signup of any given name works, so it looks fine
  // in a fresh environment and fails only as an install accumulates users --
  // and locally every test happened to pick a distinct name.
  //
  // So: fall back to a per-user name. The suffix is the user id rather than
  // a timestamp or random value, which keeps it deterministic and means a
  // retry of the same repair lands on the same name instead of littering.
  const base = name.trim() ? `${name.trim()}'s Team` : 'My Team'

  for (const teamName of [base, `${base} (${userId})`]) {
    const teamId = await insertTeam(teamName, userId, email)
    if (teamId !== null)
      return teamId
  }

  log.error(`[teamContext] exhausted every team name for user#${userId}`)
  return null
}

/** One attempt at a given name. Null on any failure, including a collision. */
async function insertTeam(teamName: string, userId: number, email: string): Promise<number | null> {
  try {
    // Check first so an expected collision costs a read instead of an
    // exception, and keep the catch below for the race between the two.
    const taken = await db.selectFrom('teams').where('name', '=', teamName).select(['id']).executeTakeFirst()
    if (taken?.id) {
      log.info(`[teamContext] team name "${teamName}" is taken, trying the next candidate`)
      return null
    }

    const now = new Date().toISOString()
    await db.insertInto('teams').values({ name: teamName, status: 'active' }).execute()

    // Read back rather than trusting a returned id: the dialect differs
    // between the self-hosted SQLite and the hosted Postgres, and this runs
    // on both. Safe to match on name -- it is unique, which is the point.
    const created = await db.selectFrom('teams').where('name', '=', teamName).select(['id']).executeTakeFirst()
    if (!created?.id) {
      log.error(`[teamContext] created team "${teamName}" for user#${userId} and could not read it back`)
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

    log.info(`[teamContext] created team#${teamId} ("${teamName}") for user#${userId}`)
    return teamId
  }
  catch (err) {
    // Loud, and with the reason attached. The original call site swallowed
    // this into a bare console.error, which is why a unique-constraint
    // violation went unexplained for as long as it did.
    log.error(`[teamContext] failed to create team "${teamName}" for user#${userId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
