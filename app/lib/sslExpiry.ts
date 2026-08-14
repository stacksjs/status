/**
 * Pure decision logic for SSL certificate checks, extracted from
 * app/Jobs/RunSslCheck.ts so the subtle parts — the once-per-threshold
 * warning dedup and the incident scoping predicate — are unit-testable
 * without a TLS handshake. Same split as consensusStatus / assertionEval /
 * heartbeat: the job owns I/O, this module owns the decisions.
 */

/** Alert thresholds, in days before expiry. */
export const WARNING_THRESHOLDS_DAYS = [30, 14, 7, 1]

const MS_PER_DAY = 1000 * 60 * 60 * 24

/**
 * Whole days from `nowMs` until `expiresAtMs`. Floored, so a certificate
 * with 13.9 days left reads as 13 (crossing the 14-day threshold rather
 * than hovering just outside it). Negative once expired.
 */
export function daysUntilExpiry(expiresAtMs: number, nowMs: number): number {
  return Math.floor((expiresAtMs - nowMs) / MS_PER_DAY)
}

/**
 * The tightest warning threshold a certificate has crossed, or null when
 * it isn't near expiry. 12 days out -> 14; 40 days out -> null. An expired
 * certificate (negative days) has crossed every threshold, so it returns
 * the tightest one — though callers treat expiry as an incident, not a
 * warning.
 */
export function crossedThreshold(days: number): number | null {
  const crossed = WARNING_THRESHOLDS_DAYS.filter(threshold => days <= threshold)
  return crossed.length > 0 ? Math.min(...crossed) : null
}

/**
 * The threshold to warn at right now, or null to stay quiet.
 *
 * Warn once per threshold crossing: the threshold crossed at this check is
 * compared against the one already crossed at the previous check, so a
 * 60-second check interval doesn't page every minute for a week. A renewed
 * certificate (fingerprint change) resets the comparison — a *new* cert
 * that is already near expiry deserves its own warning, and the previous
 * cert's position on the ladder says nothing about it.
 */
export function warnAtThreshold(input: {
  daysUntilExpiry: number
  previousDaysUntilExpiry: number | null
  fingerprintChanged: boolean
}): number | null {
  const threshold = crossedThreshold(input.daysUntilExpiry)
  if (threshold === null)
    return null

  const previousThreshold = input.previousDaysUntilExpiry === null || input.fingerprintChanged
    ? null
    : crossedThreshold(input.previousDaysUntilExpiry)

  return threshold === previousThreshold ? null : threshold
}

/**
 * Whether an incident's `impacted_checks` marks it as this job's own — the
 * scoping that keeps SSL dedup/auto-resolve from touching an incident some
 * other check type opened on the same monitor (an uptime outage and an
 * expired certificate are different problems and resolve independently).
 * Malformed JSON is treated as "not ours", which fails safe: the worst
 * case is opening a second incident, never silently resolving someone
 * else's.
 */
export function isSslIncident(impactedChecks: string | null | undefined): boolean {
  try {
    return JSON.parse(impactedChecks || '[]')[0]?.type === 'ssl'
  }
  catch {
    return false
  }
}

/**
 * The TLS port to probe for a monitor URL: the explicit port when the URL
 * carries one (https://host:8443/), else 443. A service on a nonstandard
 * TLS port was previously unmonitorable — the job always dialed 443.
 */
export function tlsPortFor(url: URL): number {
  const explicit = Number.parseInt(url.port, 10)
  return Number.isFinite(explicit) && explicit > 0 ? explicit : 443
}
