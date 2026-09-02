import type { HostAggregate, ServerStatus } from './agentHosts'
import { log } from '@stacksjs/logging'
import Incident from '../Models/Incident'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'
import { describeBreaches } from './agentHosts'
import { isMonitorInMaintenance } from './maintenance'

/**
 * The two incidents a Server can raise about itself. Everything here is
 * keyed on the KIND, never on the cause string: the cause embeds live
 * percentages ("CPU 96% ≥ 90%"), so cause-based dedup — which is what
 * openIncident() does for monitors — never matched across two ticks. That is
 * how one production monitor came to hold five simultaneously open "host
 * threshold breached" incidents, and the fleet 45.
 */
export type ServerIncidentKind = 'server_hot' | 'server_silent'

/** The columns of a `servers` row this module needs. */
export interface ServerRow {
  id: number
  team_id: number
  name: string
  status: ServerStatus
  metrics_window_seconds: number | null
}

interface HotMarker { type: 'server_hot', hosts: { host: string, breaches: string[] }[] }
interface SilentMarker { type: 'server_silent', reason: 'missed_push', windowSeconds: number }

/**
 * True when the box has monitors and every one of them is inside a
 * maintenance window.
 *
 * A server has no maintenance window of its own; its sites do. Requiring ALL
 * of them is the conservative reading: one site on the box still being
 * watched means somebody wants to hear that the box is hot. A box with no
 * monitors at all is never suppressed — there is nothing to infer from.
 */
export async function isServerInMaintenance(serverId: number, atMs = Date.now()): Promise<boolean> {
  const monitors = await Monitor.where('server_id', serverId).get()
  if (monitors.length === 0)
    return false

  for (const monitor of monitors) {
    if (!(await isMonitorInMaintenance(monitor.id, atMs)))
      return false
  }

  return true
}

/** The kind marker an incident carries, or null when it is not a server incident. */
function markerOf(incident: { impacted_checks?: string | null }): HotMarker | SilentMarker | null {
  try {
    const first = JSON.parse(incident.impacted_checks || '[]')[0]
    return first?.type === 'server_hot' || first?.type === 'server_silent' ? first : null
  }
  catch {
    return null
  }
}

/**
 * The open incident of one kind on a server (oldest first), or null.
 *
 * Oldest rather than newest on purpose: if two processes ever raced and both
 * opened one, every later reconcile updates the same row and the duplicate is
 * closed by the next resolve, which takes all of a kind.
 */
export async function openServerIncidentOfKind(serverId: number, kind: ServerIncidentKind): Promise<any | null> {
  const open = await Incident.where('server_id', serverId).where('status', '!=', 'resolved').orderBy('id', 'asc').get()
  return open.find((incident: any) => markerOf(incident)?.type === kind) ?? null
}

/** Resolve every open incident of one kind on a server, posting one update each. Returns how many. */
export async function resolveServerIncidents(serverId: number, kind: ServerIncidentKind, resolvedAt: string, message: string): Promise<number> {
  const open = await Incident.where('server_id', serverId).where('status', '!=', 'resolved').get()
  let resolved = 0

  for (const incident of open) {
    if (markerOf(incident as any)?.type !== kind)
      continue

    await (incident as any).update({ status: 'resolved', resolved_at: resolvedAt })
    await IncidentUpdate.create({
      incident_id: (incident as any).id,
      message,
      status: 'resolved',
      // camelCase: the model declares postedAt and the ORM validates against
      // the declared names, so a snake_case key reads as missing (the same
      // trap app/lib/maintenance.ts documents at its ATTR_ALIASES).
      postedAt: resolvedAt,
    })
    resolved++
  }

  return resolved
}

/**
 * Open one server incident, unless the whole box is inside a maintenance
 * window. `monitorId` is null: this belongs to the box, not to any one site
 * on it, so a hot box is one incident however many monitors sit on it.
 */
async function createServerIncident(server: ServerRow, startedAt: string, cause: string, marker: HotMarker | SilentMarker): Promise<any | null> {
  const atMs = Date.parse(startedAt)
  if (await isServerInMaintenance(server.id, Number.isFinite(atMs) ? atMs : Date.now())) {
    log.debug(`[maintenance] suppressed server incident for server ${server.id} (every monitor on it is inside a window)`)
    return null
  }

  // camelCase keys, as openIncident() normalises to: the model declares its
  // attributes in camelCase and the ORM validates against the declared names.
  // The generated statics are typed `unknown`, hence the local cast.
  return (Incident as any).create({
    monitorId: null,
    serverId: server.id,
    startedAt,
    cause,
    status: 'investigating',
    impactedChecks: JSON.stringify([marker]),
  })
}

function hotMarker(fleet: HostAggregate): HotMarker {
  return {
    type: 'server_hot',
    // Sorted so "the breach set changed" is a string comparison and two hosts
    // reporting in a different order is not a change.
    hosts: fleet.breaching
      .map(reading => ({ host: reading.host, breaches: [...reading.breaches].sort() }))
      .sort((a, b) => a.host.localeCompare(b.host)),
  }
}

function sameBreachSet(existing: HotMarker | SilentMarker | null, next: HotMarker): boolean {
  return existing?.type === 'server_hot' && JSON.stringify(existing.hosts) === JSON.stringify(next.hosts)
}

/**
 * Reconcile the box's two incidents from its STATE — never from an edge.
 *
 * Called after every ingest and every CheckStaleServers tick, each with the
 * fleet it just computed from the windowed samples (a 'quiet' tick has no
 * fresh readings and passes none). Idempotent: running it twice with the same
 * state does nothing the second time.
 *
 *   healthy → resolve any open server_hot and server_silent
 *   hot     → resolve any open server_silent; open ONE server_hot if none,
 *             else update the open one in place when the breach set changed
 *   quiet   → open ONE server_silent if none (server_hot is left as it was:
 *             silence says nothing new about heat; the next push settles it)
 *   unknown → nothing (never heard from is not went quiet)
 *
 * This is the reasoning EvaluateMonitorConsensus applies to monitor recovery
 * ("Recovery is reconciled from state, NOT triggered by the down->up edge"),
 * and the reason a box can never again hold five open breach incidents:
 * there is one status column, one writer per instant in each process, a
 * compare-and-set between processes, and at most one open incident of each
 * kind. Dedup is by marker kind; the cause string embeds live percentages and
 * can never be a dedup key.
 */
export async function reconcileServerIncidents(server: ServerRow, at: string, fleet?: HostAggregate): Promise<void> {
  if (server.status === 'unknown')
    return

  // Any push or any fresh sample is proof the agent is alive.
  if (server.status !== 'quiet')
    await resolveServerIncidents(server.id, 'server_silent', at, 'Agent metrics are being received again.')

  if (server.status === 'healthy') {
    await resolveServerIncidents(server.id, 'server_hot', at, 'Host resource usage back within thresholds.')
    return
  }

  if (server.status === 'hot') {
    // Both callers pass a fleet for a 'hot' server (the ingest computes it in
    // its transaction, the tick recomputes it from the windowed samples). A
    // fleet with nothing breaching alongside status 'hot' is a stale status
    // the tick is about to rewrite; do nothing this round.
    if (!fleet || fleet.breaching.length === 0)
      return

    const marker = hotMarker(fleet)
    const cause = `Host resource threshold breached: ${describeBreaches(fleet.breaching)}`
    const open = await openServerIncidentOfKind(server.id, 'server_hot')

    if (!open) {
      await createServerIncident(server, at, cause, marker)
    }
    else if (!sameBreachSet(markerOf(open), marker)) {
      // Updated in place. incident:updated does not re-page (the notification
      // listeners fire on created, and on updated only for a resolve), so a
      // breach spreading to a second host is visible on the page without
      // waking anyone a second time.
      await open.update({ cause, impacted_checks: JSON.stringify([marker]) })
      await IncidentUpdate.create({
        incident_id: open.id,
        message: `Breaches changed: ${describeBreaches(fleet.breaching)}`,
        status: open.status,
        postedAt: at,
      })
    }

    return
  }

  // quiet
  const windowSeconds = server.metrics_window_seconds || 300
  if (!(await openServerIncidentOfKind(server.id, 'server_silent'))) {
    await createServerIncident(
      server,
      at,
      `No metrics received from '${server.name}' agent within ${windowSeconds}s`,
      { type: 'server_silent', reason: 'missed_push', windowSeconds },
    )
  }
}
