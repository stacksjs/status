/**
 * Application-health reports in the schema `spatie/laravel-health` exposes and
 * Oh Dear polls, so an app already running that package points at StatusHQ by
 * changing a URL — no StatusHQ-specific code on the customer's side:
 *
 *   {
 *     "finishedAt": "1638879833",
 *     "checkResults": [{
 *       "name": "UsedDiskSpace", "label": "Used Disk Space",
 *       "status": "failed", "notificationMessage": "The disk is almost full (91% used)",
 *       "shortSummary": "91%", "meta": { "disk_space_used_percentage": 91 }
 *     }]
 *   }
 *
 * The app measures itself and reports; we never run code on the customer's
 * box. That means a check reflects whichever process answered the request —
 * behind a load balancer, "disk 91%" is one node's disk. Per-host CPU/RAM/disk
 * is what the push agent (/api/agent/{token}/metrics) is for; this is for
 * "is the application healthy" (database reachable, queue moving, scheduler
 * alive, backups fresh).
 */

/** The five statuses the schema defines. Anything else is a contract violation. */
export const APP_HEALTH_STATUSES = ['ok', 'warning', 'failed', 'crashed', 'skipped'] as const
export type AppHealthStatus = (typeof APP_HEALTH_STATUSES)[number]

/** How stale a report may be before it stops counting as evidence. Oh Dear's rule. */
export const DEFAULT_MAX_AGE_SECONDS = 600

export interface AppHealthCheckResult {
  name?: unknown
  label?: unknown
  status?: unknown
  notificationMessage?: unknown
  shortSummary?: unknown
  meta?: unknown
}

export interface AppHealthReport {
  finishedAt?: unknown
  checkResults?: unknown
}

/** One check, normalized for storage and display. */
export interface NormalizedCheck {
  name: string
  label: string
  status: AppHealthStatus | 'unknown'
  summary: string
  message: string
}

export interface AppHealthVerdict {
  status: 'up' | 'degraded' | 'down'
  message: string
  checks: NormalizedCheck[]
  /** True when finishedAt is present and older than the max age. */
  stale: boolean
  /** null when the report omitted finishedAt, or it could not be parsed. */
  finishedAtMs: number | null
}

/**
 * Does this body look like an app-health report? Deliberately narrow: only a
 * `checkResults` array claims the schema, so an ordinary `{ status: "ok" }`
 * health endpoint keeps its existing meaning.
 */
export function isAppHealthReport(body: unknown): body is AppHealthReport {
  return !!body && typeof body === 'object' && Array.isArray((body as AppHealthReport).checkResults)
}

/**
 * `finishedAt` in the wild is a unix-seconds string ("1638879833"), a number,
 * or an ISO date depending on who implemented the endpoint. Accept all three;
 * return null when it is absent or unintelligible rather than guessing.
 */
export function parseFinishedAt(value: unknown): number | null {
  if (value == null)
    return null
  if (typeof value === 'number' && Number.isFinite(value))
    return value > 1e11 ? value : value * 1000
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed)
      return null
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed)
      return n > 1e11 ? n : n * 1000
    }
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? null : parsed
  }
  return null
}

function normalizeStatus(value: unknown): AppHealthStatus | 'unknown' {
  const s = String(value ?? '').toLowerCase()
  return (APP_HEALTH_STATUSES as readonly string[]).includes(s) ? s as AppHealthStatus : 'unknown'
}

function normalizeCheck(raw: AppHealthCheckResult): NormalizedCheck {
  const name = String(raw.name ?? '').trim() || 'unnamed'
  return {
    name,
    label: String(raw.label ?? '').trim() || name,
    status: normalizeStatus(raw.status),
    summary: String(raw.shortSummary ?? '').trim(),
    message: String(raw.notificationMessage ?? '').trim(),
  }
}

/**
 * Pill class for one check's status, so the monitor page and any future
 * surface agree on what a `warning` looks like. Mirrors the monitor-status
 * pills in app/lib/display.ts: skipped reads muted rather than green, because
 * a skipped check is not a passing one.
 */
export function checkPillClass(status: NormalizedCheck['status']): string {
  if (status === 'ok')
    return 'pill pill-up'
  if (status === 'warning')
    return 'pill pill-degraded'
  if (status === 'failed' || status === 'crashed')
    return 'pill pill-down'
  return 'pill pill-unknown'
}

/**
 * Reduce a report to one monitor verdict.
 *
 *   failed / crashed  -> down      (crashed means the check itself threw)
 *   warning           -> degraded
 *   ok                -> up
 *   skipped           -> ignored entirely; a skipped check is not evidence
 *   anything else     -> down, naming the value — an unrecognized status
 *                        cannot be read as healthy
 *
 * A report whose `finishedAt` is older than `maxAgeSeconds` is down whatever
 * the checks say: a cached or frozen response would otherwise report a
 * long-dead app as perfectly fine. A report with no `finishedAt` at all is
 * accepted (not every implementation sends one) but flagged via
 * `finishedAtMs: null` so callers can surface that.
 */
export function evaluateAppHealth(
  report: AppHealthReport,
  now: number = Date.now(),
  maxAgeSeconds: number = DEFAULT_MAX_AGE_SECONDS,
): AppHealthVerdict {
  const checks = (Array.isArray(report.checkResults) ? report.checkResults : [])
    .map(entry => normalizeCheck((entry ?? {}) as AppHealthCheckResult))

  const finishedAtMs = parseFinishedAt(report.finishedAt)
  const ageSeconds = finishedAtMs == null ? null : Math.round((now - finishedAtMs) / 1000)
  const stale = ageSeconds != null && ageSeconds > maxAgeSeconds

  if (stale) {
    return {
      status: 'down',
      message: `Health report is stale: finished ${ageSeconds}s ago, older than the ${maxAgeSeconds}s limit`,
      checks,
      stale,
      finishedAtMs,
    }
  }

  const considered = checks.filter(c => c.status !== 'skipped')
  if (considered.length === 0) {
    return {
      status: 'up',
      message: checks.length ? 'All checks skipped' : 'No checks reported',
      checks,
      stale,
      finishedAtMs,
    }
  }

  const failing = considered.filter(c => c.status === 'failed' || c.status === 'crashed')
  const unknown = considered.filter(c => c.status === 'unknown')
  const warning = considered.filter(c => c.status === 'warning')

  if (failing.length || unknown.length) {
    const parts = [
      ...failing.map(c => `${c.label}: ${c.message || c.summary || c.status}`),
      ...unknown.map(c => `${c.label}: unrecognized status`),
    ]
    return { status: 'down', message: parts.join('; '), checks, stale, finishedAtMs }
  }

  if (warning.length) {
    return {
      status: 'degraded',
      message: warning.map(c => `${c.label}: ${c.message || c.summary || 'warning'}`).join('; '),
      checks,
      stale,
      finishedAtMs,
    }
  }

  return { status: 'up', message: `All ${considered.length} checks passing`, checks, stale, finishedAtMs }
}
