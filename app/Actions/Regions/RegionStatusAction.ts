import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { consensusStatus, CONSENSUS_TYPES, regionsConfig } from '../../../config/regions'
import CheckResult from '../../Models/CheckResult'
import Monitor from '../../Models/Monitor'
import { regionTokenValid } from './regionToken'

/**
 * Regional probe fleet endpoint: GET /regions/{token}/status.
 *
 * Read-only introspection for verifying the multi-region setup end to end
 * without shell access to the primary's database: for each consensus-owned
 * monitor it reports the latest fresh result per region and the consensus
 * verdict those votes produce. This is how the second region's activation
 * is confirmed — you should see both `eu-central` and `us-east` under
 * `regions` once the Ashburn probe is live.
 */
export default new Action({
  name: 'RegionStatusAction',
  description: 'Report per-region freshness and the consensus verdict for each monitor',

  async handle(request) {
    if (!regionTokenValid(request.get('token')))
      return response.json({ success: false, message: 'Invalid region token' }, { status: 403 })

    const { regions, consensus } = regionsConfig
    const freshCutoff = new Date(Date.now() - consensus.freshnessSeconds * 1000).toISOString()
    const consensusTypes = new Set<string>(CONSENSUS_TYPES)

    const enabled = await Monitor.where('enabled', true).get()
    const monitors = enabled.filter(m => consensusTypes.has(m.type))

    const report = []
    for (const monitor of monitors) {
      const recent = await CheckResult.where('monitor_id', monitor.id)
        .where('checked_at', '>=', freshCutoff)
        .orderBy('checked_at', 'desc')
        .orderBy('id', 'desc')
        .get()

      const latestByRegion = new Map<string, any>()
      for (const r of recent) {
        const region = r.region || 'default'
        if (!latestByRegion.has(region))
          latestByRegion.set(region, r)
      }

      const votes = [...latestByRegion.entries()].map(([region, r]) => ({
        region,
        status: r.status,
        checked_at: r.checked_at,
        configured: regions.includes(region),
      }))
      const configuredVotes = votes.filter(v => v.configured)
      const counted = configuredVotes.length > 0 ? configuredVotes : votes

      report.push({
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        stored_status: monitor.status,
        consensus: consensusStatus(counted.map(v => v.status), consensus.minRegionsToConfirm),
        regions: votes,
      })
    }

    return response.json({
      success: true,
      configured_regions: regions,
      min_regions_to_confirm: consensus.minRegionsToConfirm,
      freshness_seconds: consensus.freshnessSeconds,
      monitors: report,
    })
  },
})
