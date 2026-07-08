/**
 * Maintenance-window awareness (stacksjs/status#1). During a scheduled window
 * the monitors attached to it are "expected" to fail, so per the contract in
 * docs/operate/maintenance.md: a failing check must NOT open an incident or
 * page anyone, and time inside the window is excluded from the uptime
 * percentage. This module is the single source of that logic - the pure
 * interval math (`inAnyInterval`) plus the DB-backed lookups every check job
 * and the notification listeners use. (The public status page reimplements the
 * same exclusion inline because its stx server script cannot import app/ TS -
 * keep the two in sync.)
 */

import { parseCron } from '@stacksjs/cron'
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import Incident from '../Models/Incident'

export interface Interval { startMs: number, endMs: number }

/** Whether an instant (epoch ms) falls inside any [startMs, endMs] interval, inclusive. */
export function inAnyInterval(atMs: number, intervals: Interval[]): boolean {
  for (const iv of intervals) {
    if (atMs >= iv.startMs && atMs <= iv.endMs)
      return true
  }
  return false
}

// Safety bound on recurrence expansion so a pathological range can never spin.
const MAX_OCCURRENCES = 10_000

/**
 * Expand a maintenance window into the concrete [start,end] intervals that
 * overlap [fromMs, toMs]. A one-off window (no recurrence_cron) yields its
 * single interval when it overlaps the range. A recurring window uses
 * recurrence_cron for each occurrence's start and the anchor's own duration
 * (ends_at - starts_at) for each occurrence's length. An unparseable cron
 * expression is fail-safe: treated as one-off, so a typo can't silently make a
 * window never apply.
 *
 * KEEP IN SYNC with the inline copy in resources/views/status/[slug].stx
 * (the stx server script can require npm packages like @stacksjs/cron but
 * cannot import app/ TS).
 */
export function expandWindowIntervals(
  win: { starts_at: string, ends_at: string, recurrence_cron?: string | null },
  fromMs: number,
  toMs: number,
): Interval[] {
  const startMs = Date.parse(win.starts_at)
  const endMs = Date.parse(win.ends_at)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs)
    return []

  const cron = win.recurrence_cron?.trim()
  const oneOff = (): Interval[] => (endMs >= fromMs && startMs <= toMs ? [{ startMs, endMs }] : [])
  if (!cron)
    return oneOff()

  const duration = endMs - startMs
  const intervals: Interval[] = []
  try {
    // Scan from just before the earliest occurrence that could still cover
    // fromMs (one that began up to `duration` earlier).
    let cursor = fromMs - duration - 1
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = parseCron(cron, cursor)
      if (!next)
        break
      const occStart = next.getTime()
      if (occStart > toMs)
        break
      const occEnd = occStart + duration
      if (occEnd >= fromMs)
        intervals.push({ startMs: occStart, endMs: occEnd })
      cursor = occStart // parseCron searches from the next minute, so this advances
    }
  }
  catch {
    return oneOff()
  }
  return intervals
}

/**
 * Maintenance intervals per monitor for the given monitor IDs, expanded across
 * `range` (recurring windows can produce several intervals in a range; a
 * one-off produces at most one). Cancelled windows are skipped - a cancelled
 * window means the maintenance did not happen, so its time still counts against
 * uptime and still pages. Returns monitorId -> intervals; a monitor with no
 * covering window is simply absent. `range` defaults to the current instant,
 * which is what the point-in-time checks need.
 */
export async function maintenanceIntervalsByMonitor(
  monitorIds: number[],
  range: { fromMs: number, toMs: number } = { fromMs: Date.now(), toMs: Date.now() },
): Promise<Map<number, Interval[]>> {
  const byMonitor = new Map<number, Interval[]>()
  if (monitorIds.length === 0)
    return byMonitor

  const links = await db.selectFrom('maintenance_window_monitors').whereIn('monitor_id', monitorIds).execute()
  if (links.length === 0)
    return byMonitor

  const windowIds = [...new Set(links.map((l: any) => l.maintenance_window_id))]
  const windows = (await db.selectFrom('maintenance_windows').whereIn('id', windowIds).execute())
    .filter((w: any) => w.status !== 'cancelled')

  const intervalsByWindow = new Map<number, Interval[]>()
  for (const w of windows)
    intervalsByWindow.set(w.id, expandWindowIntervals(w, range.fromMs, range.toMs))

  for (const link of links) {
    const ivs = intervalsByWindow.get(link.maintenance_window_id)
    if (!ivs || ivs.length === 0)
      continue
    const list = byMonitor.get(link.monitor_id) ?? []
    list.push(...ivs)
    byMonitor.set(link.monitor_id, list)
  }
  return byMonitor
}

/** Whether the monitor sits inside a (non-cancelled) maintenance window at `atMs` (default now). */
export async function isMonitorInMaintenance(monitorId: number, atMs: number = Date.now()): Promise<boolean> {
  const byMonitor = await maintenanceIntervalsByMonitor([monitorId], { fromMs: atMs, toMs: atMs })
  return inAnyInterval(atMs, byMonitor.get(monitorId) ?? [])
}

/**
 * Opens an incident unless the monitor is inside a maintenance window at the
 * incident's start time. During announced maintenance a failing check must not
 * open an incident (and so, via Incident's observe trait, must not page). When
 * the window closes a still-failing check opens one as usual. Returns the
 * created incident, or null when suppressed. Drop-in for `Incident.create`
 * at the auto-incident sites (none of which use the return value).
 */
export async function openIncident(attrs: { monitor_id: number, started_at?: string, [key: string]: unknown }): Promise<any | null> {
  const parsed = attrs.started_at ? Date.parse(attrs.started_at) : Number.NaN
  const atMs = Number.isFinite(parsed) ? parsed : Date.now()
  if (await isMonitorInMaintenance(attrs.monitor_id, atMs)) {
    log.debug(`[maintenance] suppressed incident for monitor ${attrs.monitor_id} (inside a maintenance window)`)
    return null
  }
  return Incident.create(attrs as any)
}
