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

/**
 * Maintenance intervals per monitor for the given monitor IDs. Cancelled
 * windows are skipped - a cancelled window means the maintenance did not
 * happen, so its time still counts against uptime and still pages. Returns
 * monitorId -> intervals; a monitor with no covering window is simply absent.
 */
export async function maintenanceIntervalsByMonitor(monitorIds: number[]): Promise<Map<number, Interval[]>> {
  const byMonitor = new Map<number, Interval[]>()
  if (monitorIds.length === 0)
    return byMonitor

  const links = await db.selectFrom('maintenance_window_monitors').whereIn('monitor_id', monitorIds).execute()
  if (links.length === 0)
    return byMonitor

  const windowIds = [...new Set(links.map((l: any) => l.maintenance_window_id))]
  const windows = (await db.selectFrom('maintenance_windows').whereIn('id', windowIds).execute())
    .filter((w: any) => w.status !== 'cancelled')

  const intervalByWindow = new Map<number, Interval>()
  for (const w of windows) {
    const startMs = Date.parse(w.starts_at)
    const endMs = Date.parse(w.ends_at)
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs)
      intervalByWindow.set(w.id, { startMs, endMs })
  }

  for (const link of links) {
    const iv = intervalByWindow.get(link.maintenance_window_id)
    if (!iv)
      continue
    const list = byMonitor.get(link.monitor_id) ?? []
    list.push(iv)
    byMonitor.set(link.monitor_id, list)
  }
  return byMonitor
}

/** Whether the monitor sits inside a (non-cancelled) maintenance window at `atMs` (default now). */
export async function isMonitorInMaintenance(monitorId: number, atMs: number = Date.now()): Promise<boolean> {
  const byMonitor = await maintenanceIntervalsByMonitor([monitorId])
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
