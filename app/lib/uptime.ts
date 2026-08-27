import type { Interval } from './maintenance'
import { consensusStatus, regionsConfig } from '../../config/regions'
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
 * Degraded does NOT count against uptime. A degraded check answered — the
 * request was served, just slowly, or a host was busy — and uptime measures
 * whether the thing was up. This is also what the product has always promised
 * prospects in writing: features/performance-monitoring.stx says a
 * degradation leaves "your uptime percentage untouched". The code disagreed
 * with that page, on both the status page and the report emails.
 *
 * It matters most for server monitors, whose degraded state is a CPU, RAM or
 * disk threshold breach. Counting those against uptime meant a box at 51%
 * against a 50% threshold cost exactly as much uptime as a box that was
 * switched off.
 *
 * Anything that genuinely could not be reached is 'down' and does count:
 * a failed probe, or an agent that stopped pushing entirely
 * (CheckStaleMetrics).
 *
 * Maintenance windows are excluded, per docs/operate/maintenance.md: a
 * planned outage must not dent the number. Callers pass the intervals; this
 * module does the filtering so every caller drops the same rows.
 *
 * ── Regions ──
 * Every probe region writes its OWN check_results row, so a monitor watched
 * from three regions writes three rows per tick. The monitor's up/down status
 * does not come from those rows directly: EvaluateMonitorConsensus reads the
 * latest fresh result per region and requires `minRegionsToConfirm` of them to
 * agree before it calls a monitor down, precisely "so a single region's
 * network blip can no longer open (or resolve) an incident".
 *
 * Uptime skipped that step. It counted every region's row flat, so one probe
 * that could not reach the target — a silent worker, a token mismatch, a
 * route from one datacentre — cost real uptime and painted the day bars red
 * while the pill next to them stayed green, because the pill went through
 * consensus and the number did not. A health monitor answering in 375ms
 * showed 89.68%.
 *
 * When a caller passes `roundMs`, rows are grouped into rounds and each round
 * is resolved through the SAME consensusStatus the pill uses, so the two
 * finally agree. Single-region data is left exactly as it was: one row per
 * round is its own consensus.
 *
 * ── Day bars ──
 * The day bar is ratio-based, not worst-status-wins. It used to be the
 * latter, which is the same all-or-nothing mistake this module was extracted
 * to fix in the percentage — a day that was 99.93% up rendered identically to
 * a day that was down from midnight, so the bars contradicted the number
 * printed directly above them. Green means a clean day, amber means it was
 * blemished, red is reserved for a day that was actually substantially down.
 */

export type CheckStatus = 'up' | 'down' | 'degraded' | string

export interface CheckRow {
  checked_at: string
  status: CheckStatus
  /** Probe region that produced the row. Absent or empty means 'default'. */
  region?: string | null
}

export interface UptimeOptions {
  /**
   * Width of a consensus round, in ms. Rows from different regions landing
   * within this of one another are votes on the same round and collapse to a
   * single consensus verdict.
   *
   * Omit it (or pass 0) to count every row on its own, which is what a
   * single-region deployment wants and what every caller did before regions
   * existed. Use `roundMsForInterval` rather than picking a number: it has to
   * be wider than the spread between regions starting the same tick and
   * narrower than the gap to the next one.
   */
  roundMs?: number
  /**
   * Regions that must agree before a round counts as down. Defaults to the
   * deployment's own consensus setting, so uptime and the status pill cannot
   * drift apart.
   */
  minRegionsToConfirm?: number
  /**
   * Uptime ratio at or above which a blemished day paints amber instead of
   * red. At the default, a day needs to lose more than 1% of its checks —
   * about 15 minutes at one check a minute — before it reads as an outage.
   */
  dayDownBelow?: number
}

const DEFAULT_DAY_DOWN_BELOW = 0.99

/**
 * A round width for a monitor that checks every `seconds`.
 *
 * Half the interval, clamped: wide enough that regions starting the same tick
 * a few seconds apart land together, narrow enough that the next tick starts a
 * new round. The 30s ceiling keeps slow monitors (a 30-minute interval) from
 * swallowing genuinely separate rounds into one.
 */
export function roundMsForInterval(seconds: number | null | undefined): number {
  const s = Number(seconds)
  if (!Number.isFinite(s) || s <= 0)
    return 30_000
  return Math.max(5_000, Math.min(30_000, (s * 1000) / 2))
}

export interface UptimeDay {
  /** YYYY-MM-DD. */
  day: string
  /** Worst status seen that day, or 'unknown' when no checks landed. */
  status: 'up' | 'down' | 'degraded' | 'unknown'
  /** Checks that were not down. Degraded counts as up — see above. */
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
  options: UptimeOptions = {},
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

  // Normalise once: drop maintenance, drop rows outside the window, drop
  // statuses the bar cannot represent. `day` keeps coming off the string
  // rather than the parsed timestamp so a row's bucket is unchanged from
  // before regions existed.
  interface Usable { ts: number, day: string, status: string, region: string }
  const usable: Usable[] = []
  for (const row of rows) {
    const ts = Date.parse(row.checked_at)
    if (!Number.isFinite(ts))
      continue
    if (intervals.length && inAnyInterval(ts, intervals))
      continue

    const day = String(row.checked_at).slice(0, 10)
    if (!indexByDay.has(day))
      continue

    // Anything outside up/down/degraded would skew the denominator without
    // being representable in the bar, so it is not counted at all. The
    // check_results CHECK constraint should make this unreachable.
    if (rank(row.status) === 0)
      continue

    usable.push({ ts, day, status: String(row.status), region: (row.region && String(row.region)) || 'default' })
  }

  // One unit of measurement. With a single region that is one check, exactly
  // as before. With several it is one ROUND, resolved through consensus, so
  // one region's failure is a vote rather than a verdict.
  const regionCount = new Set(usable.map(u => u.region)).size
  const roundMs = options.roundMs ?? 0
  const units = (regionCount > 1 && roundMs > 0)
    ? collapseToRounds(usable, roundMs, options.minRegionsToConfirm ?? regionsConfig.consensus.minRegionsToConfirm)
    : usable.map(u => ({ day: u.day, status: u.status }))

  // Per-day tallies. down/degraded are counted separately from `up` because
  // the bar's colour needs to tell "clean" from "blemished" from "out", and
  // `up` alone (which counts degraded as up, deliberately) cannot.
  const downByDay = new Array<number>(buckets.length).fill(0)
  const degradedByDay = new Array<number>(buckets.length).fill(0)

  let upChecks = 0
  let totalChecks = 0

  for (const unit of units) {
    const index = indexByDay.get(unit.day)
    if (index === undefined)
      continue
    const bucket = buckets[index]
    if (!bucket)
      continue

    bucket.total++
    totalChecks++

    if (unit.status === 'down') {
      downByDay[index]!++
    }
    else {
      bucket.up++
      upChecks++
      if (unit.status === 'degraded')
        degradedByDay[index]!++
    }
  }

  const dayDownBelow = options.dayDownBelow ?? DEFAULT_DAY_DOWN_BELOW
  for (let i = 0; i < buckets.length; i++) {
    const bucket = buckets[i]!
    if (bucket.total === 0) {
      bucket.status = 'unknown'
      continue
    }
    if (downByDay[i] === 0 && degradedByDay[i] === 0) {
      bucket.status = 'up'
      continue
    }
    // Blemished. Red is for a day that genuinely lost service; a day that
    // stayed above the threshold reads as amber however it was blemished.
    bucket.status = (downByDay[i]! > 0 && bucket.up / bucket.total < dayDownBelow) ? 'down' : 'degraded'
  }

  return {
    pct: totalChecks > 0 ? (upChecks / totalChecks) * 100 : null,
    days: buckets,
    upChecks,
    totalChecks,
  }
}

/**
 * Collapse per-region rows into one consensus verdict per round.
 *
 * Rounds are built greedily off a time-sorted list rather than by rounding
 * timestamps to a grid: regions start the same tick a few seconds apart, and a
 * fixed grid would split those onto either side of a boundary and turn one
 * round into two half-populated ones.
 *
 * Within a round the newest row per region wins, matching how
 * EvaluateMonitorConsensus picks each region's vote.
 *
 * A round that collected only ONE vote — regions running different intervals,
 * or one that drifted past the window — is decided by that vote alone, because
 * consensusStatus clamps `required` to the number of votes actually cast. That
 * is not a special case bolted on here: it is exactly what the pill does with a
 * region whose result has gone stale, and keeping the two identical is the
 * whole point. Widen `roundMs` if a deployment's regions straggle more than
 * half a check interval apart.
 */
function collapseToRounds(
  usable: { ts: number, day: string, status: string, region: string }[],
  roundMs: number,
  minRegionsToConfirm: number,
): { day: string, status: string }[] {
  const sorted = [...usable].sort((a, b) => a.ts - b.ts)
  const rounds: { day: string, votes: Map<string, string> }[] = []
  let startTs = Number.NEGATIVE_INFINITY
  let current: { day: string, votes: Map<string, string> } | null = null

  for (const row of sorted) {
    if (!current || row.ts - startTs > roundMs) {
      current = { day: row.day, votes: new Map() }
      startTs = row.ts
      rounds.push(current)
    }
    current.votes.set(row.region, row.status)
  }

  return rounds.map(round => ({
    day: round.day,
    status: consensusStatus([...round.votes.values()], minRegionsToConfirm),
  }))
}
