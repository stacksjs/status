/**
 * Server-metrics alerting config + evaluation (stacksjs/status#1 — server
 * metrics threshold alerting). A reportsMetrics monitor keeps its alert
 * thresholds and missed-push window in the monitor's `config` JSON (same
 * store as every other monitor type's per-type settings), so nothing new
 * on the schema. Shared by ReceiveMetricsAction (per-push evaluation) and
 * CheckStaleMetrics (missed-push detection) so both read the same values.
 */

export interface MetricsThresholds {
  /** Alert when CPU% >= this. 0 disables CPU alerting. */
  cpu: number
  /** Alert when memory% >= this. 0 disables memory alerting. */
  ram: number
  /** Alert when disk% >= this (only when the agent reports disk). 0 disables. */
  disk: number
  /** Mark the host down if no metrics push arrives within this many seconds. */
  windowSeconds: number
}

// Defaults match the values documented in docs/monitors/server-metrics.md.
export const DEFAULT_METRICS_THRESHOLDS: MetricsThresholds = { cpu: 90, ram: 90, disk: 85, windowSeconds: 300 }

function nonNegNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/** Parse the alert thresholds + missed-push window from a monitor's config JSON. */
export function parseMetricsThresholds(configJson: string | null | undefined): MetricsThresholds {
  let cfg: Record<string, unknown> = {}
  try {
    cfg = configJson ? JSON.parse(configJson) as Record<string, unknown> : {}
  }
  catch {
    cfg = {}
  }
  return {
    cpu: nonNegNumber(cfg.cpuThreshold, DEFAULT_METRICS_THRESHOLDS.cpu),
    ram: nonNegNumber(cfg.ramThreshold, DEFAULT_METRICS_THRESHOLDS.ram),
    disk: nonNegNumber(cfg.diskThreshold, DEFAULT_METRICS_THRESHOLDS.disk),
    windowSeconds: nonNegNumber(cfg.metricsWindowSeconds, DEFAULT_METRICS_THRESHOLDS.windowSeconds) || DEFAULT_METRICS_THRESHOLDS.windowSeconds,
  }
}

export interface MetricsSample {
  cpuPercent: number
  ramPercent: number
  /** Optional — only evaluated against the disk threshold when the agent sends it. */
  diskPercent?: number | null
}

/**
 * Return a human-readable reason for each threshold the sample breaches (or
 * an empty array when the host is healthy). A threshold of 0 disables that
 * metric. Disk is only considered when the agent actually reported it.
 */
export function evaluateBreaches(sample: MetricsSample, thresholds: MetricsThresholds): string[] {
  const breaches: string[] = []
  if (thresholds.cpu > 0 && sample.cpuPercent >= thresholds.cpu)
    breaches.push(`CPU ${sample.cpuPercent.toFixed(0)}% ≥ ${thresholds.cpu}%`)
  if (thresholds.ram > 0 && sample.ramPercent >= thresholds.ram)
    breaches.push(`memory ${sample.ramPercent.toFixed(0)}% ≥ ${thresholds.ram}%`)
  if (typeof sample.diskPercent === 'number' && thresholds.disk > 0 && sample.diskPercent >= thresholds.disk)
    breaches.push(`disk ${sample.diskPercent.toFixed(0)}% ≥ ${thresholds.disk}%`)
  return breaches
}
