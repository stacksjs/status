import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import Incident from '../../Models/Incident'
import Monitor from '../../Models/Monitor'
import Server from '../../Models/Server'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `POST /api/incidents` — overrides the `store` route the `useApi` trait on
 * app/Models/Incident.ts generates (user-defined routes take priority over
 * the generated ones, the same way `POST /monitors` overrides the monitor
 * store).
 *
 * The generated store had no tenant check at all, and could not have one:
 * `incidents` has no `team_id` column, so the auto-CRUD layer's team scoping
 * (which keys on that column) never engaged. Any authenticated caller could
 * therefore POST an incident naming ANY team's `monitor_id` — and, once
 * Servers landed, any team's `server_id` — and `observe: true` would fire
 * `incident:created`, which app/Events.ts routes to SendIncidentNotification,
 * which fans the incident's `cause` out over the named row's team's channels.
 * That is an unauthenticated-content paging vector into another tenant's
 * Slack/SMS/email, with the attacker choosing the message body.
 *
 * So ownership is resolved here, before anything is written: exactly one of
 * `monitor_id` / `server_id`, and the row it names must be in the caller's
 * own team. `team_id` is never read from the body — it comes from the
 * credentials, as CreateMonitorAction does.
 */
export default new Action({
  name: 'CreateIncidentAction',
  description: 'Create an incident against a monitor or server the caller\'s team owns',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const rawMonitorId = request.get('monitor_id')
    const rawServerId = request.get('server_id')
    const monitorId = rawMonitorId == null || rawMonitorId === '' ? null : Number(rawMonitorId)
    const serverId = rawServerId == null || rawServerId === '' ? null : Number(rawServerId)

    // Exactly one. An incident belongs either to a site or to a box; both at
    // once has no meaning (and would make every downstream reader's
    // monitor_id-or-server_id branch ambiguous), neither belongs to nobody
    // and would be unreachable — and unownable, so unguardable.
    if ((monitorId == null) === (serverId == null) || Number.isNaN(monitorId) || Number.isNaN(serverId))
      return response.json({ error: 'exactly one of monitor_id or server_id is required' }, { status: 422 })

    const owned = monitorId != null
      ? await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      : await Server.where('id', serverId!).where('team_id', authTeamId).first()

    // 403, not 404: the caller is authenticated and the endpoint exists; what
    // they cannot do is attach an incident to a row that is not theirs.
    if (!owned)
      return response.forbidden('You do not have access to this monitor or server')

    const impacted = request.get('impacted_checks')

    // camelCase keys, as the model declares its attributes and every other
    // Incident.create call site in the app uses. The generated statics are
    // typed `unknown`, hence the local cast.
    const incident = await (Incident as any).create({
      monitorId,
      serverId,
      startedAt: request.get('started_at') ?? new Date().toISOString(),
      resolvedAt: request.get('resolved_at'),
      cause: request.get('cause'),
      status: request.get('status') ?? 'investigating',
      impactedChecks: impacted == null ? undefined : (typeof impacted === 'string' ? impacted : JSON.stringify(impacted)),
    })

    return response.json(incident, { status: 201 })
  },
})
