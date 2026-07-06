import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { CONSENSUS_TYPES } from '../../../config/regions'
import Monitor from '../../Models/Monitor'
import { regionTokenValid } from './regionToken'

/**
 * Regional probe fleet endpoint: GET /regions/{token}/monitors.
 *
 * A remote check region (e.g. the Ashburn worker) has no database of its
 * own — it pulls the list of monitors it should probe from the primary over
 * this endpoint, runs the checks locally, and POSTs the region-tagged
 * results back via IngestRegionResultsAction. This is the "push probe"
 * topology: the primary keeps its own database and the remote region never
 * touches it directly, so adding a region needs no shared/networked DB.
 *
 * Auth is the unguessable REGIONAL_INGEST_TOKEN in the URL — the same
 * token-is-the-secret pattern as /ping/{token} and /agent/{token}/metrics.
 *
 * Only the region-sensitive availability types (CONSENSUS_TYPES: uptime,
 * ping, tcp_port, health) are returned; ssl/dns/domain/lighthouse/etc. are
 * not location-dependent and stay owned by the primary's own jobs.
 */
export default new Action({
  name: 'ListRegionMonitorsAction',
  description: 'List the monitors a remote check region should probe',

  async handle(request) {
    if (!regionTokenValid(request.get('token')))
      return response.json({ success: false, message: 'Invalid region token' }, { status: 403 })

    const consensusTypes = new Set<string>(CONSENSUS_TYPES)
    const enabled = await Monitor.where('enabled', true).get()
    const monitors = enabled
      .filter(m => consensusTypes.has(m.type))
      .map(m => ({
        id: m.id,
        type: m.type,
        url: m.url,
        // Only the check-shaping bits the probe needs (tcp port, health
        // path); never the full monitor row.
        config: m.config ?? null,
        check_interval_seconds: m.check_interval_seconds ?? 60,
      }))

    return response.json({ success: true, monitors })
  },
})
