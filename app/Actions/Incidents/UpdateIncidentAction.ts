import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import Incident from '../../Models/Incident'
import { incidentBelongsToTeam } from '../../lib/incidentOwnership'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `PATCH /api/incidents/{id}` — overrides the `update` route the `useApi`
 * trait on app/Models/Incident.ts generates, for the reason spelled out in
 * CreateIncidentAction: `incidents` has no `team_id`, so the generated route
 * was writable by any authenticated caller from any team.
 *
 * Two guards, not one. Ownership (404 — a foreign incident is not
 * distinguishable from a missing one, and saying "forbidden" would confirm
 * the id exists) and immutability of the two ownership columns: re-pointing
 * an incident's `monitor_id` or `server_id` after creation would walk it into
 * another tenant, and `observe: true` would fan the caller's `cause` out over
 * that tenant's channels on the next update — the same paging vector the
 * create guard closes, reached from the other side.
 *
 * Everything else is applied through `incident.update(...)` rather than a raw
 * query, so `incident:updated` still fires and SendIncidentResolvedNotification
 * still runs for a genuine resolve.
 */
export default new Action({
  name: 'UpdateIncidentAction',
  description: 'Update an incident belonging to the caller\'s team',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const id = request.get('id')
    const incident = await Incident.find(Number(id))

    if (!incident || !(await incidentBelongsToTeam(incident, authTeamId)))
      return response.json({ error: `Incident ${id} not found` }, { status: 404 })

    const rawMonitorId = request.get('monitor_id')
    const rawServerId = request.get('server_id')
    const wouldMove
      = (rawMonitorId != null && rawMonitorId !== '' && Number(rawMonitorId) !== Number(incident.monitor_id))
        || (rawServerId != null && rawServerId !== '' && Number(rawServerId) !== Number(incident.server_id))

    if (wouldMove)
      return response.json({ error: 'monitor_id and server_id cannot be changed' }, { status: 422 })

    // Only the fields actually present in the body — a PATCH that carries
    // `status` alone must not blank `cause` back to undefined.
    const changes: Record<string, unknown> = {}
    for (const [body, column] of [
      ['cause', 'cause'],
      ['status', 'status'],
      ['started_at', 'startedAt'],
      ['resolved_at', 'resolvedAt'],
    ] as const) {
      const value = request.get(body)
      if (value !== undefined)
        changes[column] = value
    }

    const impacted = request.get('impacted_checks')
    if (impacted !== undefined)
      changes.impactedChecks = typeof impacted === 'string' ? impacted : JSON.stringify(impacted)

    if (Object.keys(changes).length > 0)
      await incident.update(changes as any)

    return response.json(await Incident.find(incident.id))
  },
})
