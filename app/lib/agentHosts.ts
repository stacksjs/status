/**
 * Per-host identity for pushed server metrics.
 *
 * Before this, every agent pushing to one monitor was the same anonymous
 * series: four app servers behind a load balancer overwrote each other, and
 * the chart showed whichever node reported last. Both SDKs (@statushq/agent
 * and statushq/laravel) send a `host` with every sample, and this is what the
 * ingest does with it.
 *
 * The interesting part is not storing the name — it is that a monitor with
 * several hosts can no longer take its status from the newest sample alone.
 * One node breaching and another healthy would otherwise flap the monitor
 * up/down once a minute, which is worse than not having the field at all.
 */

export const DEFAULT_HOST = 'default'

/** Long enough for an FQDN; a longer one is a bug or an attempt at abuse. */
export const MAX_HOST_LENGTH = 64

/**
 * A hostname safe to store, group by and display.
 *
 * Sanitised rather than rejected: the value comes from `hostname()` on someone
 * else's machine, and refusing a sample because a container was named with an
 * underscore would lose monitoring over cosmetics. Lowercased because
 * hostnames are case-insensitive and `Web-01` must not become a second series
 * next to `web-01`.
 */
export function normalizeHost(raw: unknown): string {
  if (typeof raw !== 'string')
    return DEFAULT_HOST

  const cleaned = raw
    .trim()
    .toLowerCase()
    // Anything outside the hostname alphabet collapses to a single dash, so a
    // pasted control character cannot break a table cell or a log line.
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_HOST_LENGTH)

  return cleaned === '' ? DEFAULT_HOST : cleaned
}

export interface HostReading {
  host: string
  status: 'up' | 'down'
  breaches: string[]
  checkedAtMs: number
  cpuPercent: number | null
  ramPercent: number | null
  diskPercent: number | null
}

interface CheckResultRow {
  status?: string | null
  metadata?: string | null
  checked_at?: string | null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Parse agent CheckResult rows into readings, skipping anything unreadable. */
export function readingsFromRows(rows: readonly CheckResultRow[]): HostReading[] {
  const readings: HostReading[] = []

  for (const row of rows) {
    const checkedAtMs = Date.parse(row.checked_at ?? '')
    if (!Number.isFinite(checkedAtMs))
      continue

    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(row.metadata ?? '{}') as Record<string, unknown>
    }
    catch {
      meta = {}
    }

    readings.push({
      host: normalizeHost(meta.host),
      status: row.status === 'down' ? 'down' : 'up',
      breaches: Array.isArray(meta.breaches) ? meta.breaches.filter((b): b is string => typeof b === 'string') : [],
      checkedAtMs,
      cpuPercent: numberOrNull(meta.cpuPercent),
      ramPercent: numberOrNull(meta.ramPercent),
      diskPercent: numberOrNull(meta.diskPercent),
    })
  }

  return readings
}

/** The most recent reading for each host, newest first. */
export function latestPerHost(readings: readonly HostReading[]): HostReading[] {
  const latest = new Map<string, HostReading>()

  for (const reading of readings) {
    const existing = latest.get(reading.host)
    if (!existing || reading.checkedAtMs > existing.checkedAtMs)
      latest.set(reading.host, reading)
  }

  return [...latest.values()].sort((a, b) => b.checkedAtMs - a.checkedAtMs)
}

export interface HostAggregate {
  status: 'up' | 'down'
  /** Hosts currently breaching a threshold, newest first. */
  breaching: HostReading[]
  /** Every host considered, newest first. */
  hosts: HostReading[]
}

/**
 * The monitor's status across all of its hosts: down if any fresh host is
 * breaching.
 *
 * Readings older than the monitor's window are ignored rather than counted as
 * down. A node that breached and then stopped pushing — decommissioned,
 * rebuilt, renamed — would otherwise pin the monitor down forever with no way
 * to clear it. A host that goes silent is CheckStaleMetrics' business, and it
 * watches the monitor as a whole.
 */
export function aggregateHostStatus(readings: readonly HostReading[], nowMs: number, windowSeconds: number): HostAggregate {
  const hosts = latestPerHost(readings).filter(reading => nowMs - reading.checkedAtMs <= windowSeconds * 1000)
  const breaching = hosts.filter(reading => reading.status === 'down')

  return { status: breaching.length > 0 ? 'down' : 'up', breaching, hosts }
}

/**
 * The incident cause for a set of breaching hosts.
 *
 * Named per host, because "CPU 96% ≥ 90%" across a fleet does not say which
 * machine to open a shell on — and that is the first thing the person woken
 * up needs to know.
 */
export function describeBreaches(breaching: readonly HostReading[]): string {
  return breaching
    .map(reading => reading.host === DEFAULT_HOST
      ? reading.breaches.join('; ')
      : `${reading.host}: ${reading.breaches.join('; ')}`)
    .filter(part => part !== '')
    .join(' | ')
}
