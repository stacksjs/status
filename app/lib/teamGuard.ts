import { response } from '@stacksjs/router'
import { resolveTeamOrFailure } from './teamContext'

/**
 * The team gate every dashboard action sits behind.
 *
 * Returns the caller's team id, or a Response to hand straight back:
 *
 *   const team = await requireTeamId(request)
 *   if (team instanceof Response) return team
 *
 * This exists because all 32 actions previously wrote the same two lines --
 * resolve, and on null `response.unauthorized('Authentication required')` --
 * which was wrong for half the cases it caught. Team resolution returns
 * nothing both when there is no session AND when a valid session has no
 * workspace, and answering the second with "Authentication required" sends a
 * signed-in user to log in again, which cannot possibly help. It also made
 * the underlying fault invisible: every report looked like an auth problem.
 *
 * Splitting it has a second use while the production failure is unexplained.
 * A 401 now means the session was not accepted; a 409 means it was, and the
 * workspace could not be provided. From outside the box those two are
 * indistinguishable today, so the next production probe tells us which half
 * we are in instead of costing another guess.
 */
export async function requireTeamId(request: unknown): Promise<number | Response> {
  const outcome = await resolveTeamOrFailure(request)

  if (typeof outcome === 'number')
    return outcome

  if (outcome === 'no_session')
    return response.unauthorized('Authentication required')

  // Deliberately not 401/403: nothing is wrong with the credentials, and
  // nothing the user does will change the answer. 409 says the account is in
  // a state the server could not resolve.
  return new Response(
    JSON.stringify({
      success: false,
      message: 'Your account has no workspace, and one could not be created. This is a server-side problem, not a sign-in problem.',
      code: 'team_unavailable',
    }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  )
}
