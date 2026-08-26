import type { Interval } from './maintenance'
import { inAnyInterval } from './maintenance'

/**
 * Uptime over a window of check results, as a percentage and as one bucket
 * per day.
 *
 * This exists because the number was being derived two different ways. The
 * public status page and the uptime report emails both weighted it by CHECK
 * — up / total — which is what every monitoring tool means by uptime. The
 * dashboard's monitor page weighted it by DAY, and classified a day as down
 * if it contained a single failed check:
 *
 *     if (row.down_count > 0) dayStatus = 'down'
 *     uptimePercent = upDays / daysWithData
 *
 * So a monitor checked every minute, up for 2169 of 2170 checks, with one bad
 * minute on each of the three days it had existed, reported 0.00% uptime
 * beside a green "Up" pill. The failure mode is worst on exactly the monitors
 * you care most about: the more often you check, the likelier every single
 * day contains one blip, and the closer the number drives to zero.
 *
 * Degraded counts AGAINST uptime — only 'up' is up. That is what both
 * existing implementations did, and SendUptimeReports states it as a
 * decision rather than an accident ("degraded counts against uptime"), so
 * this module preserves it; unifying the math should not quietly move the
 * numbers on a customer's public status page.
 *
 * Worth knowing that it contradicts what the product promises in writing.
 * resources/views/features/performance-monitoring.stx tells prospects a
 * degradation incident leaves "your uptime percentage untouched". One of the
 * two has to give, and which one is a product call, not a refactor's to make.
 *
 * Maintenance windows are excluded, per docs/operate/maintenance.md: a
 * planned outage must not dent the number. Callers pass the intervals; this
 * module does the filtering so every caller drops the same rows.
 */

export type CheckStatus = 'up' | 'down' | 'degraded' | string

export interface CheckRow {
  checked_at: string
  status: CheckStatus
}

export interface UptimeDay {
  /** YYYY-MM-DD. */
  day: string
  /** Worst status seen that day, or 'unknown' when no checks landed. */
  status: 'up' | 'down' | 'degraded' | 'unknown'
  /** Checks that reported up. Degraded is not counted here — see above. */
  up: number
  total: number
}

export interface UptimeSummary {
  /** up / total as a percentage, or null when nothing was measured. */
  pct: number | null
  /** One entry per day, oldest first, gaps included as 'unknown'. */
  days: UptimeDay[]
  upChecks: number
  totalChecks: number
}

/** Rank for worst-status-wins, matching the public status page's bars. */
function rank(status: string): number {
  if (status === 'down') return 3
  if (status === 'degraded') return 2
  if (status === 'up') return 1
  return 0
}

/**
 * @param rows check_results rows for one monitor, any order.
 * @param days how many days the window covers, ending today.
 * @param intervals maintenance windows to exclude; pass [] for none.
 * @param nowMs injectable clock, so tests don't depend on the wall clock.
 */
export function computeUptime(
  rows: CheckRow[],
  days: number,
  intervals: Interval[] = [],
  nowMs: number = Date.now(),
): UptimeSummary {
  // Seed one bucket per day so a gap renders as "no data" rather than
  // collapsing the axis onto the days that do have checks.
  const buckets: UptimeDay[] = []
  const indexByDay = new Map<string, number>()
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(nowMs - i * 86400000).toISOString().slice(0, 10)
    indexByDay.set(key, buckets.length)
    buckets.push({ day: key, status: 'unknown', up: 0, total: 0 })
  }

  let upChecks = 0
  let totalChecks = 0

  for (const row of rows) {
    if (intervals.length && inAnyInterval(Date.parse(row.checked_at), intervals))
      continue

    const index = indexByDay.get(String(row.checked_at).slice(0, 10))
    if (index === undefined)
      continue

    // Anything outside up/down/degraded would skew the denominator without
    // being representable in the bar, so it is not counted at all. The
    // check_results CHECK constraint should make this unreachable.
    if (rank(row.status) === 0)
      continue

    const bucket = buckets[index]
    if (!bucket)
      continue

    bucket.total++
    totalChecks++

    if (row.status === 'up') {
      bucket.up++
      upChecks++
    }

    if (rank(row.status) > rank(bucket.status))
      bucket.status = row.status as UptimeDay['status']
  }

  return {
    pct: totalChecks > 0 ? (upChecks / totalChecks) * 100 : null,
    days: buckets,
    upChecks,
    totalChecks,
  }
}
