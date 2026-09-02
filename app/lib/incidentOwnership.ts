import Monitor from '../Models/Monitor'
import Server from '../Models/Server'

/**
 * Which team an incident belongs to, resolved through the row it points at.
 *
 * `incidents` has no `team_id` column: an incident's tenant is its monitor's,
 * or — for the two box-level kinds a Server raises about itself, which carry
 * `monitor_id: null` — its server's. Every caller-facing incident endpoint has
 * to make that hop before it will read or write a row, or one team can reach
 * another team's incidents by guessing an id (IDOR).
 *
 * A monitor-keyed incident is checked against `monitors`, a server-keyed one
 * against `servers`; an incident pointing at neither (or at a row that has
 * since been deleted) belongs to nobody and is never accessible. Checking
 * `monitor_id` first matters: `Monitor.where('id', null)` matches nothing, so
 * a server incident run through the monitor branch would look "not found" to
 * its rightful owner — which is exactly what made server_hot and
 * server_silent incidents impossible to acknowledge.
 */
export async function incidentBelongsToTeam(
  incident: { monitor_id?: number | null, server_id?: number | null },
  teamId: number,
): Promise<boolean> {
  if (incident.monitor_id != null)
    return Boolean(await Monitor.where('id', incident.monitor_id).where('team_id', teamId).first())

  if (incident.server_id != null)
    return Boolean(await Server.where('id', incident.server_id).where('team_id', teamId).first())

  return false
}
