/**
 * Server-metrics alerting config + evaluation (stacksjs/status#1 — server
 * metrics threshold alerting).
 *
 * Thresholds and the missed-push window are columns on `servers` now
 * (thresholdsForServer), read by ReceiveMetricsAction on every push and by
 * CheckStaleServers on every tick so both evaluate the same values. They used
 * to live in each monitor's `config` JSON, which meant two monitors on one box
 * carried two independent threshold sets for one CPU; parseMetricsThresholds
 * still reads that shape for the pre-migration ingest fallback
 * (legacyReceiveMetrics) and the backfill, and is deleted with them.
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

/**
 * Thresholds and window from a `servers` row — columns, not config JSON.
 *
 * Takes the raw row rather than a Server model instance because all three
 * readers (the ingest, the tick, the backfill) come off the query builder:
 * `status` and `last_sample_at` are not fillable, so the server path never
 * loads the model just to read four numbers.
 */
export function thresholdsForServer(server: {
  cpu_threshold?: unknown
  ram_threshold?: unknown
  disk_threshold?: unknown
  metrics_window_seconds?: unknown
}): MetricsThresholds {
  return {
    cpu: nonNegNumber(server.cpu_threshold, DEFAULT_METRICS_THRESHOLDS.cpu),
    ram: nonNegNumber(server.ram_threshold, DEFAULT_METRICS_THRESHOLDS.ram),
    disk: nonNegNumber(server.disk_threshold, DEFAULT_METRICS_THRESHOLDS.disk),
    // A window of 0 is not "no window", it is a misconfiguration that would
    // make every server permanently overdue — same fallback as the config
    // parser below.
    windowSeconds: nonNegNumber(server.metrics_window_seconds, DEFAULT_METRICS_THRESHOLDS.windowSeconds) || DEFAULT_METRICS_THRESHOLDS.windowSeconds,
  }
}

/**
 * Parse the alert thresholds + missed-push window from a monitor's config
 * JSON. Legacy: only the pre-migration ingest fallback and the backfill read
 * thresholds from a monitor now.
 */
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
