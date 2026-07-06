import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { CONSENSUS_TYPES, regionsConfig } from '../../../config/regions'
import CheckResult from '../../Models/CheckResult'
import Monitor from '../../Models/Monitor'
import { regionTokenValid } from './regionToken'

const VALID_STATUS = new Set(['up', 'down', 'degraded'])

interface IncomingResult {
  monitor_id: number
  status: string
  response_time_ms?: number | null
  status_code?: number | null
  message?: string
  metadata?: string
  checked_at?: string
}

/**
 * Regional probe fleet endpoint: POST /regions/{token}/results.
 *
 * A remote check region POSTs a batch of the results it just gathered; each
 * becomes a region-tagged CheckResult row on the primary. The primary's
 * EvaluateMonitorConsensus job (every minute) then reads the latest fresh
 * result per region and decides monitor up/down from cross-region
 * agreement — so this endpoint only *records* observations, it never opens
 * or resolves incidents itself, exactly like the primary's own check jobs.
 *
 * Body: { "region": "us-east", "results": [ { monitor_id, status,
 * response_time_ms?, status_code?, message?, metadata?, checked_at? }, ... ] }.
 * Read from the raw body (not request.get) so the array survives intact.
 *
 * .skipCsrf() on the route: hit by a server-side probe with a bearer-style
 * URL token, never a browser form, so it can never carry a CSRF token.
 */
export default new Action({
  name: 'IngestRegionResultsAction',
  description: 'Record a batch of region-tagged check results pushed by a remote probe',

  async handle(request) {
    if (!regionTokenValid(request.get('token')))
      return response.json({ success: false, message: 'Invalid region token' }, { status: 403 })

    let payload: { region?: string, results?: IncomingResult[] }
    try {
      payload = JSON.parse(await request.text())
    }
    catch {
      return response.json({ success: false, message: 'Body must be valid JSON' }, { status: 422 })
    }

    const region = String(payload.region ?? '').trim()
    if (!region)
      return response.json({ success: false, message: 'region is required' }, { status: 422 })

    // Only accept a region the primary is actually configured to weigh in
    // consensus — a typo'd region would otherwise inflate the vote count and
    // silently skew the threshold. A remote probe must never post as the
    // primary's own region either (that would let it fake local agreement).
    const primaryRegion = process.env.WORKER_REGION || 'default'
    if (!regionsConfig.regions.includes(region) || region === primaryRegion) {
      return response.json(
        { success: false, message: `region must be one of the configured remote regions (${regionsConfig.regions.filter(r => r !== primaryRegion).join(', ') || 'none'})` },
        { status: 422 },
      )
    }

    const results = Array.isArray(payload.results) ? payload.results : []
    if (results.length === 0)
      return response.json({ success: false, message: 'results must be a non-empty array' }, { status: 422 })

    const consensusTypes = new Set<string>(CONSENSUS_TYPES)
    let inserted = 0
    const skipped: Array<{ monitor_id: unknown, reason: string }> = []

    for (const r of results) {
      const monitorId = Number(r.monitor_id)
      const status = String(r.status)

      if (!Number.isInteger(monitorId) || !VALID_STATUS.has(status)) {
        skipped.push({ monitor_id: r.monitor_id, reason: 'bad monitor_id or status' })
        continue
      }

      const monitor = await Monitor.find(monitorId)
      if (!monitor || !consensusTypes.has(monitor.type)) {
        skipped.push({ monitor_id: monitorId, reason: 'unknown or non-consensus monitor' })
        continue
      }

      const checkedAt = typeof r.checked_at === 'string' && r.checked_at ? r.checked_at : new Date().toISOString()

      await CheckResult.create({
        monitor_id: monitorId,
        status,
        response_time_ms: r.response_time_ms != null ? Math.round(Number(r.response_time_ms)) : null,
        status_code: r.status_code != null ? Number(r.status_code) : null,
        message: typeof r.message === 'string' ? r.message.slice(0, 1000) : '',
        metadata: typeof r.metadata === 'string' ? r.metadata : JSON.stringify({}),
        region,
        checked_at: checkedAt,
      })

      // Advance last_checked_at so the primary's DispatchDueChecks and the
      // dashboard "last checked" reflect that this region just probed too.
      // Status is deliberately NOT set here — consensus owns that.
      await monitor.update({ last_checked_at: checkedAt })
      inserted++
    }

    return response.json({ success: true, region, inserted, skipped })
  },
})
