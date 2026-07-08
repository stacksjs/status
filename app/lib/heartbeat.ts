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

import { parseCron } from '@stacksjs/cron'

export interface HeartbeatState {
  /** created_at in ms — the baseline before the very first ping. */
  createdAtMs: number
  /** last successful ping, or null if none has arrived yet. */
  lastPingAtMs: number | null
  /** last `/start` ping, or null. */
  lastStartedAtMs: number | null
  expectedIntervalSeconds: number
  graceSeconds: number
  /**
   * Optional 5-field cron expression (or nickname). When present and valid it
   * drives the next-expected-ping deadline instead of expectedIntervalSeconds.
   */
  cronExpression?: string | null
}

export type HeartbeatVerdict =
  | { down: false }
  | { down: true, reason: 'missed' | 'overrun' }

/** Whether a cron expression parses (5-field, nicknames, ranges/steps/names). */
export function isValidCron(expression: string): boolean {
  try {
    return parseCron(expression, 0) !== null
  }
  catch {
    return false
  }
}

/**
 * The next expected ping time (ms) after `baselineMs`. With a valid cron
 * expression this is the next scheduled slot; otherwise it's a fixed interval
 * after the baseline. An unparseable cron expression falls back to the
 * interval — fail-safe, so a typo can't leave a monitor that never alerts.
 */
export function nextExpectedPingMs(state: HeartbeatState, baselineMs: number): number {
  const expr = state.cronExpression?.trim()
  if (expr) {
    try {
      const next = parseCron(expr, baselineMs)
      if (next)
        return next.getTime()
    }
    catch {
      // fall through to the interval below
    }
  }
  return baselineMs + state.expectedIntervalSeconds * 1000
}

/**
 * Decide whether a heartbeat monitor is down at `now` (ms). A run that has
 * started but not yet reported success is "in flight"; if it stays in flight
 * past start + grace it is an overrun. Overrun is checked first because it
 * fires sooner than the classic missed-check deadline (which is anchored to
 * the last success, so it would also fire eventually — just a full interval
 * later).
 */
export function evaluateHeartbeat(state: HeartbeatState, now: number): HeartbeatVerdict {
  const { createdAtMs, lastPingAtMs, lastStartedAtMs, graceSeconds } = state

  const inFlight = lastStartedAtMs != null && (lastPingAtMs == null || lastStartedAtMs > lastPingAtMs)
  if (inFlight && now >= lastStartedAtMs! + graceSeconds * 1000)
    return { down: true, reason: 'overrun' }

  const baseline = lastPingAtMs ?? createdAtMs
  if (now >= nextExpectedPingMs(state, baseline) + graceSeconds * 1000)
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
