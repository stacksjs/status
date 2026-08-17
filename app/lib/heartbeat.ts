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
import { isValidCron } from './cron'

export { isValidCron }

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

/**
 * The three public URLs a customer's job calls, derived in one place so the
 * dashboard, the docs and the tests cannot drift apart. `routes/api.ts` is
 * auto-prefixed with `/api` by the framework's route loader, so the served
 * path is `/api/ping/{token}` — not the bare `/ping/{token}` the route file
 * declares. Getting this wrong is silent and expensive: the ping 404s, the
 * job looks fine, and the monitor pages the customer for a missed check-in.
 */
export function pingUrls(appUrl: string, token: string): { success: string, start: string, fail: string } {
  const base = `${String(appUrl).replace(/\/+$/, '')}/api/ping/${token}`
  return { success: base, start: `${base}/start`, fail: `${base}/fail` }
}

/**
 * A whole-number, human duration: "45s", "5m", "1h 30m", "2d". Used for
 * cadence, grace and measured run durations, so they all read alike.
 */
export function formatDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds))
    return '—'
  const total = Math.max(0, Math.round(seconds))
  if (total < 60)
    return `${total}s`
  if (total < 3600) {
    const m = Math.floor(total / 60)
    const s = total % 60
    return s ? `${m}m ${s}s` : `${m}m`
  }
  if (total < 86_400) {
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3600)
  return h ? `${d}d ${h}h` : `${d}d`
}

/**
 * How the monitor's cadence is expressed, for display. A valid cron
 * expression drives the deadline (see nextExpectedPingMs), so it is what the
 * customer needs to see; an invalid one silently falls back to the interval,
 * and saying so is the only way that fallback is ever visible.
 */
export function describeCadence(state: Pick<HeartbeatState, 'expectedIntervalSeconds' | 'cronExpression'>): string {
  const expr = state.cronExpression?.trim()
  if (expr && isValidCron(expr))
    return `cron ${expr} (UTC)`
  if (expr)
    return `every ${formatDurationSeconds(state.expectedIntervalSeconds)} (cron expression "${expr}" is not valid — ignored)`
  return `every ${formatDurationSeconds(state.expectedIntervalSeconds)}`
}

/**
 * The dashboard's view of a heartbeat. Deliberately built *on top of*
 * evaluateHeartbeat rather than beside it: the card must show what
 * CheckOverdueHeartbeats would decide, and re-deriving "is it down" here is
 * exactly how a status card starts lying about the alert it is paired with.
 */
export type HeartbeatDisplayState = 'awaiting' | 'healthy' | 'running' | 'missed' | 'overrun'

export interface HeartbeatSummary {
  /** Identical to evaluateHeartbeat's verdict. */
  down: boolean
  reason: 'missed' | 'overrun' | null
  state: HeartbeatDisplayState
  /** Deadline for the next success ping (ms), grace included. */
  dueAtMs: number
  /** Seconds until that deadline; negative once it has passed. */
  dueInSeconds: number
  /** A run is in flight: /start arrived with no success after it. */
  inFlight: boolean
  /** True until the very first success ping lands. */
  awaitingFirstPing: boolean
}

export function summarizeHeartbeat(state: HeartbeatState, now: number): HeartbeatSummary {
  const verdict = evaluateHeartbeat(state, now)
  const inFlight = state.lastStartedAtMs != null
    && (state.lastPingAtMs == null || state.lastStartedAtMs > state.lastPingAtMs)
  const awaitingFirstPing = state.lastPingAtMs == null

  // Mirror evaluateHeartbeat's own precedence: an in-flight run is judged
  // against start + grace, everything else against the cadence deadline.
  const graceMs = state.graceSeconds * 1000
  const dueAtMs = inFlight
    ? state.lastStartedAtMs! + graceMs
    : nextExpectedPingMs(state, state.lastPingAtMs ?? state.createdAtMs) + graceMs

  const displayState: HeartbeatDisplayState = verdict.down
    ? verdict.reason
    : inFlight ? 'running' : awaitingFirstPing ? 'awaiting' : 'healthy'

  return {
    down: verdict.down,
    reason: verdict.down ? verdict.reason : null,
    state: displayState,
    dueAtMs,
    dueInSeconds: Math.round((dueAtMs - now) / 1000),
    inFlight,
    awaitingFirstPing,
  }
}
