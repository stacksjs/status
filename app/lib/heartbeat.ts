/**
 * Pure heartbeat / cron-monitor timing logic, extracted so the deadline math
 * is unit-testable without a database. A heartbeat monitor is passive: it is
 * never polled, only watched against a deadline. Two things can make it go
 * down:
 *
 *  - `missed`  the expected ping never arrived within cadence + grace
 *              (the job is overdue, hung, or the box is down).
 *  - `overrun` a `/start` ping was received but no matching success arrived
 *              within the grace window (the run took too long / errored
 *              without a `/fail`).
 *
 * See docs/monitors/cron-heartbeats.md for the customer-facing contract.
 */

export interface HeartbeatState {
  /** created_at in ms — the baseline before the very first ping. */
  createdAtMs: number
  /** last successful ping, or null if none has arrived yet. */
  lastPingAtMs: number | null
  /** last `/start` ping, or null. */
  lastStartedAtMs: number | null
  expectedIntervalSeconds: number
  graceSeconds: number
}

export type HeartbeatVerdict =
  | { down: false }
  | { down: true, reason: 'missed' | 'overrun' }

/**
 * Decide whether a heartbeat monitor is down at `now` (ms). A run that has
 * started but not yet reported success is "in flight"; if it stays in flight
 * past start + grace it is an overrun. Overrun is checked first because it
 * fires sooner than the classic missed-check deadline (which is anchored to
 * the last success, so it would also fire eventually — just a full interval
 * later).
 */
export function evaluateHeartbeat(state: HeartbeatState, now: number): HeartbeatVerdict {
  const { createdAtMs, lastPingAtMs, lastStartedAtMs, expectedIntervalSeconds, graceSeconds } = state

  const inFlight = lastStartedAtMs != null && (lastPingAtMs == null || lastStartedAtMs > lastPingAtMs)
  if (inFlight && now >= lastStartedAtMs! + graceSeconds * 1000)
    return { down: true, reason: 'overrun' }

  const baseline = lastPingAtMs ?? createdAtMs
  if (now >= baseline + (expectedIntervalSeconds + graceSeconds) * 1000)
    return { down: true, reason: 'missed' }

  return { down: false }
}

/**
 * Run duration in whole seconds for a success that follows a `/start`, or null
 * when there was no start to measure against (or the clocks disagree and the
 * success looks earlier than the start).
 */
export function runDurationSeconds(startedAtMs: number | null, completedMs: number): number | null {
  if (startedAtMs == null || completedMs < startedAtMs)
    return null
  return Math.round((completedMs - startedAtMs) / 1000)
}

/** Sub-ping kinds accepted at /ping/{token}/{kind}; anything else is rejected. */
export const PING_KINDS = ['start', 'fail'] as const
export type PingKind = (typeof PING_KINDS)[number]

export function isPingKind(value: unknown): value is PingKind {
  return value === 'start' || value === 'fail'
}
