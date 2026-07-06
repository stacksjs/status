import process from 'node:process'

/**
 * Multi-region check + consensus configuration (stacksjs/status#1 Phase 11).
 *
 * A monitor checked from a single network location can't tell "the target
 * is actually down" from "our one probe lost its route to it" — so a
 * monitor's availability status and its incident open/resolve are decided
 * by EvaluateMonitorConsensus from the *agreement* of the configured
 * regions, not by any single check job.
 *
 * (Named `regions` rather than `monitoring` because config/monitoring.ts is
 * already taken by the framework's error-tracking bundle — a different
 * concept entirely.)
 *
 * Single-box / self-hosted installs leave MONITOR_REGIONS unset: `regions`
 * collapses to the one WORKER_REGION (default 'default'),
 * `minRegionsToConfirm` clamps to 1 at evaluation time, and consensus
 * reproduces the classic "latest check wins" behavior exactly. There is
 * nothing to configure for a self-hoster.
 */
function parseRegions(): string[] {
  const raw = process.env.MONITOR_REGIONS || process.env.WORKER_REGION || 'default'
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  return list.length > 0 ? list : ['default']
}

export interface RegionsConfig {
  /** Every probe region that participates in consensus (each fleet's WORKER_REGION). */
  regions: string[]
  consensus: {
    /**
     * How many regions must independently report a monitor down before an
     * incident opens. The effective threshold at evaluation time is clamped
     * to the number of regions that actually have fresh data, so a genuine
     * outage still alerts even when only one region has reported.
     */
    minRegionsToConfirm: number
    /**
     * A region's most recent check counts toward consensus only if it
     * landed within this many seconds — a region whose worker has gone
     * silent doesn't get to veto (or force) a verdict with a stale result.
     */
    freshnessSeconds: number
  }
}

export const regionsConfig: RegionsConfig = {
  regions: parseRegions(),
  consensus: {
    minRegionsToConfirm: Number(process.env.CONSENSUS_MIN_REGIONS) || 2,
    freshnessSeconds: Number(process.env.CONSENSUS_FRESHNESS_SECONDS) || 600,
  },
}

/**
 * Monitor types whose up/down status is region-based and therefore owned by
 * consensus. The others (ssl, dns, domain, lighthouse, performance,
 * blocklist, port_scan, cron, ai_check) are not location-sensitive — a cert
 * is the same cert from anywhere — and keep their own inline status +
 * incident logic in their respective jobs.
 */
export const CONSENSUS_TYPES = ['uptime', 'ping', 'tcp_port', 'health'] as const

export type CheckStatus = 'up' | 'down' | 'degraded' | 'unknown'

/**
 * Decide a monitor's consensus status from the latest per-region vote
 * statuses. `required` is clamped to the number of votes actually present,
 * so a genuine outage still alerts when only one region has reported (a
 * silent region can't force a false "all good"). Pure + exported so it can
 * be unit-tested in isolation from the DB — the EvaluateMonitorConsensus
 * job is the only caller.
 *
 * - `down`      when at least `required` regions report down.
 * - `degraded`  when at least `required` report down-or-degraded (but not
 *               enough are outright down).
 * - `up`        when the down/degraded votes are below threshold and at
 *               least one region reports up.
 * - `unknown`   only when there are no votes at all.
 *
 * With a single region, `required` clamps to 1, so the newest check's
 * status wins — identical to the pre-consensus inline behavior.
 */
export function consensusStatus(voteStatuses: string[], minRegionsToConfirm: number): CheckStatus {
  if (voteStatuses.length === 0)
    return 'unknown'
  const down = voteStatuses.filter(s => s === 'down').length
  const degraded = voteStatuses.filter(s => s === 'degraded').length
  const up = voteStatuses.filter(s => s === 'up').length
  const required = Math.max(1, Math.min(voteStatuses.length, minRegionsToConfirm))
  if (down >= required)
    return 'down'
  if (down + degraded >= required)
    return 'degraded'
  if (up > 0)
    return 'up'
  return 'degraded'
}

export default regionsConfig
