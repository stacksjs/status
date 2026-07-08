/**
 * Small helpers for reading per-monitor settings out of the `config` JSON
 * column (the same store every monitor type uses for its per-type options),
 * plus the pure decision logic for the config-driven threshold alerts, so
 * that logic can be unit-tested without a live network check.
 */

export type CheckStatus = 'up' | 'down' | 'degraded'

export function parseMonitorConfig(json: string | null | undefined): Record<string, unknown> {
  try {
    return json ? JSON.parse(json) as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

/** A non-negative number from config, or `fallback` when absent/invalid. */
export function configNumber(cfg: Record<string, unknown>, key: string, fallback = 0): number {
  const v = cfg[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback
}

/** A boolean from config, or `fallback` when absent/invalid. */
export function configBool(cfg: Record<string, unknown>, key: string, fallback = false): boolean {
  const v = cfg[key]
  return typeof v === 'boolean' ? v : fallback
}

/**
 * A reachable ('up') check whose latency meets or exceeds the configured
 * threshold is reported 'degraded' - slow but serving - so the dashboard
 * and consensus surface a warning instead of a hard down. `thresholdMs <= 0`
 * (the default) disables it. Never downgrades a 'down'/'degraded' result.
 */
export function applyLatencyThreshold(status: CheckStatus, responseTimeMs: number | null, thresholdMs: number): CheckStatus {
  if (status === 'up' && thresholdMs > 0 && typeof responseTimeMs === 'number' && responseTimeMs >= thresholdMs)
    return 'degraded'
  return status
}

/**
 * A reachable host that is dropping packets above the configured loss
 * threshold, or answering slower than the RTT threshold, is 'degraded'.
 * `lossThresholdPercent`/`rttThresholdMs` of 0 disable their respective
 * check. (A host dropping ALL packets is already 'down' upstream.)
 */
export function applyPingDegradation(
  status: CheckStatus,
  rttMs: number | null,
  lossPercent: number | null,
  opts: { rttThresholdMs: number, lossThresholdPercent: number },
): { status: CheckStatus, reason: string | null } {
  if (status !== 'up')
    return { status, reason: null }
  if (opts.lossThresholdPercent > 0 && typeof lossPercent === 'number' && lossPercent >= opts.lossThresholdPercent)
    return { status: 'degraded', reason: `packet loss ${lossPercent.toFixed(0)}% >= ${opts.lossThresholdPercent}%` }
  if (opts.rttThresholdMs > 0 && typeof rttMs === 'number' && rttMs >= opts.rttThresholdMs)
    return { status: 'degraded', reason: `RTT ${rttMs.toFixed(0)}ms >= ${opts.rttThresholdMs}ms` }
  return { status, reason: null }
}
