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
 * The second dialect: what a Stacks app answers on /health.
 *
 *   {
 *     "status": "ok",
 *     "timestamp": 1756382400000,
 *     "services": [{ "name": "Database", "status": "healthy",
 *                    "latency": "12ms", "uptime": "99.9%" }]
 *   }
 *
 * Every Stacks app has this the moment it is created — the framework's
 * default routes register `route.health()` and ship a HealthAction — so a
 * customer running one should be able to point a health monitor at it and
 * have it work, exactly as a Laravel app running spatie/laravel-health can.
 * Before this, `isAppHealthReport` rejected it (no `checkResults`) and the
 * monitor fell through to the plain-endpoint branch, which reads a body like
 * this as an opaque 200 and reports "up" no matter what the services say —
 * a critical database would have gone unnoticed.
 */
export interface StacksHealthService {
  name?: unknown
  status?: unknown
  latency?: unknown
  uptime?: unknown
}

export interface StacksHealthReport {
  status?: unknown
  timestamp?: unknown
  services?: unknown
}

/** Narrow, for the same reason isAppHealthReport is: only a `services` array claims it. */
export function isStacksHealthReport(body: unknown): body is StacksHealthReport {
  return !!body && typeof body === 'object' && Array.isArray((body as StacksHealthReport).services)
}

/**
 * Stacks' service statuses, mapped onto the five this module already
 * reasons about. `critical` is failed rather than crashed: the service is
 * down, but the check itself ran and said so — crashed means the check threw.
 *
 * Only these three are emitted by the framework today. Anything else is left
 * unmapped ON PURPOSE, so it lands as 'unknown' and evaluates to down: a
 * status we cannot read must never be assumed healthy.
 */
const STACKS_STATUS_MAP: Record<string, AppHealthStatus> = {
  healthy: 'ok',
  degraded: 'warning',
  critical: 'failed',
}

/**
 * Convert a Stacks report into the canonical shape, so there is exactly one
 * evaluator and the two dialects cannot drift apart in what they call down.
 *
 * `timestamp` becomes `finishedAt` — it is `Date.now()` in milliseconds, which
 * parseFinishedAt already reads correctly via its >1e11 branch — so staleness
 * works identically for both dialects.
 */
export function fromStacksHealthReport(body: StacksHealthReport): AppHealthReport {
  const services = Array.isArray(body.services) ? body.services : []
  return {
    finishedAt: body.timestamp,
    checkResults: services.map((entry) => {
      const service = (entry ?? {}) as StacksHealthService
      const name = String(service.name ?? '').trim() || 'unnamed'
      const raw = String(service.status ?? '').trim().toLowerCase()
      const mapped = STACKS_STATUS_MAP[raw]
      const latency = String(service.latency ?? '').trim()
      return {
        name,
        label: name,
        // Unmapped statuses pass through untouched so normalizeStatus can
        // reject them, rather than being silently coerced to something safe.
        status: mapped ?? service.status,
        shortSummary: latency,
        notificationMessage: mapped && mapped !== 'ok'
          ? `${name} is ${raw}${latency ? ` (${latency})` : ''}`
          : '',
      }
    }),
  }
}

/**
 * Accept either dialect and return the canonical shape, or null when the body
 * is neither. Oh Dear is tested first so an endpoint that somehow carries both
 * keys keeps the meaning it had before Stacks support existed.
 */
export function coerceHealthReport(body: unknown): AppHealthReport | null {
  if (isAppHealthReport(body))
    return body
  if (isStacksHealthReport(body))
    return fromStacksHealthReport(body)
  return null
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
