/**
 * The monitor types the scheduler actively polls — i.e. the ones for which
 * DispatchDueChecks fans out a check job on a timer.
 *
 * This list is the single source of truth for "does something actively probe
 * this monitor?", and it exists because that question has two callers that
 * must agree:
 *
 *  - DispatchDueChecks / RunCheckAction map each of these to its check job.
 *    Both type their map as `Record<PolledMonitorType, ...>`, so dropping a
 *    type here (or adding one without a runner) is a compile error rather
 *    than a monitor that silently stops being checked.
 *
 *  - ReceiveMetricsAction must NOT advance `last_checked_at` for these. That
 *    column is the probe's scheduling clock: DispatchDueChecks computes
 *    `dueAt = last_checked_at + interval`, so anything else writing it moves
 *    the next probe further away. An agent pushing metrics every 30s against
 *    a 60s interval keeps `dueAt` permanently in the future and the probe
 *    never runs at all — production monitor 49 stopped being probed from
 *    2026-08-21T08:44 for exactly this reason, while monitor 48 survived only
 *    because its agent happened to push slightly slower than its interval.
 *
 * Excluded on purpose: 'cron' (heartbeat monitors are passive — the customer's
 * job calls us, see CheckOverdueHeartbeats) and 'ai_check' (fans out one job
 * per attached assertion rather than one per monitor, so DispatchDueChecks
 * handles it separately and touches `last_checked_at` itself).
 */
export const POLLED_MONITOR_TYPES = [
  'uptime',
  // 'performance' runs the same HTTP check as uptime; the distinction is
  // intent, not mechanism (see DispatchDueChecks' CHECK_JOBS).
  'performance',
  'ssl',
  'ping',
  'tcp_port',
  'dns',
  'domain',
  'health',
  'broken_links',
  'lighthouse',
  'port_scan',
  'dns_blocklist',
] as const

export type PolledMonitorType = typeof POLLED_MONITOR_TYPES[number]

const POLLED = new Set<string>(POLLED_MONITOR_TYPES)

/**
 * True when the scheduler runs a check job for this monitor type on a timer,
 * which means `last_checked_at` belongs to that probe and nothing else may
 * advance it.
 */
export function isActivelyPolled(type: string | null | undefined): boolean {
  return typeof type === 'string' && POLLED.has(type)
}
