import { Action } from '@stacksjs/actions'
import Incident from '../../Models/Incident'
import IncidentUpdate from '../../Models/IncidentUpdate'

/**
 * `POST /incidents/:id/acknowledge` — fills the one gap the auto-generated
 * `useApi` CRUD on Incident (index/store/show/update) doesn't cover: a
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
    const id = request.get('id')
    const incident = await Incident.find(Number(id))

    if (!incident)
      return { success: false, message: `Incident ${id} not found` }

    if (incident.status !== 'investigating')
      return { success: true, message: `Incident ${id} is already '${incident.status}'`, incident }

    await incident.update({ status: 'identified' })
    await IncidentUpdate.create({
      incident_id: incident.id,
      message: 'Incident acknowledged.',
      status: 'identified',
      posted_at: new Date().toISOString(),
    })

    return { success: true, message: `Incident ${id} acknowledged`, incident: await Incident.find(incident.id) }
  },
})
