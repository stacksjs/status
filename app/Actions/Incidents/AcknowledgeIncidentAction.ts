import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import Incident from '../../Models/Incident'
import IncidentUpdate from '../../Models/IncidentUpdate'
import { incidentBelongsToTeam } from '../../lib/incidentOwnership'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `POST /incidents/:id/acknowledge` — fills the one gap the rest of the
 * Incident API (index/show, plus the team-checked store/update overrides in
 * routes/api.ts) doesn't cover: a
 * one-step "we've seen this" action a human hits from an alert, rather than
 * having to PATCH the full resource with a status string (stacksjs/status#1
 * Phase 10). Moves 'investigating' -> 'identified' and posts a timeline
 * entry, same shape as the auto-resolve path in RunUptimeCheck. A no-op
 * (not an error) if the incident is already past 'investigating' or already
 * resolved — acknowledging is idempotent, not a state-machine violation.
 */
export default new Action({
  name: 'AcknowledgeIncidentAction',
  description: 'Acknowledge an open incident',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const id = request.get('id')
    const incident = await Incident.find(Number(id))

    if (!incident)
      return { success: false, message: `Incident ${id} not found` }

    // Incident has no team_id of its own — ownership flows through its
    // monitor, or, for the two box-level kinds, through its server. Verify
    // that row belongs to the caller's team so one team can't acknowledge
    // another team's incidents by guessing the id (IDOR).
    if (!(await incidentBelongsToTeam(incident, authTeamId)))
      return { success: false, message: `Incident ${id} not found` }

    if (incident.status !== 'investigating')
      return { success: true, message: `Incident ${id} is already '${incident.status}'`, incident }

    await incident.update({ status: 'identified' })
    await IncidentUpdate.create({
      incident_id: incident.id,
      message: 'Incident acknowledged.',
      status: 'identified',
      postedAt: new Date().toISOString(),
    })

    return { success: true, message: `Incident ${id} acknowledged`, incident: await Incident.find(incident.id) }
  },
})
