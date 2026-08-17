import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { evaluateAssertions } from '../Actions/Assertions/EvaluateAssertionsAction'
import { DEFAULT_MAX_AGE_SECONDS, evaluateAppHealth, isAppHealthReport } from '../lib/appHealth'
import CheckResult from '../Models/CheckResult'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * Application health monitoring. The target app exposes a JSON endpoint
 * (default the monitor's own URL — set monitor.config.path to point at e.g.
 * "/health" instead) and this job polls it. Three contracts are understood,
 * in this precedence order:
 *
 * 1. Field assertions, when the monitor defines any — the monitor's own
 *    contract always wins. See the Assertion model.
 * 2. `{ "finishedAt": ..., "checkResults": [...] }` — the schema
 *    spatie/laravel-health exposes and Oh Dear polls, so an app already set
 *    up for Oh Dear works here by changing a URL. Per-check statuses
 *    (ok/warning/failed/crashed/skipped) reduce to one verdict and a report
 *    older than config.healthMaxAgeSeconds is down regardless of content.
 *    Set config.healthSecret to send the `oh-dear-health-check-secret`
 *    header that package validates. See app/lib/appHealth.ts.
 * 3. The original contract:
 *
 *   { "status": "ok" | "degraded" | "down", "checks"?: { [name]: boolean } }
 *
 * `checks` is optional structured detail (disk space, queue depth, a
 * downstream API reachability flag, ...) surfaced in the CheckResult
 * message for diagnosis; `status` drives the up/down/degraded state for a
 * monitor with no assertions.
 *
 * When the monitor has field assertions (see the Assertion model), those are
 * the contract instead: after a 2xx response, every assertion must pass -
 * including dot-path assertions into the JSON body, e.g.
 * `checks.database.latency_ms` less-than `100`. See
 * docs/monitors/health-checks.md and app/lib/assertionEval.ts.
 */
export default new Job({
  name: 'RunHealthCheck',
  description: 'Poll an application health endpoint for a monitor',
  queue: 'checks',
  tries: 2,
  backoff: 10,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunHealthCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let config: { path?: string, healthSecret?: string, healthMaxAgeSeconds?: number } = {}
    try {
      config = monitor.config ? JSON.parse(monitor.config) : {}
    }
    catch {
      // malformed config JSON — use the monitor URL as-is
    }

    const url = config.path ? new URL(config.path, monitor.url).toString() : monitor.url
    const checkedAt = new Date().toISOString()
    const startedAt = performance.now()

    let status: 'up' | 'down' | 'degraded' = 'down'
    let message = ''
    let metadata: Record<string, unknown> = {}

    try {
      // SSRF guard: only fetch http/https. url derives from user-supplied
      // monitor.url, and Bun's fetch honors file:/data:/blob: — an unguarded
      // fetch would read local files into the health result.
      const scheme = new URL(url).protocol
      if (scheme !== 'http:' && scheme !== 'https:')
        throw new Error('Invalid monitor URL: only http/https targets are supported')

      // The shared secret goes in the header spatie/laravel-health already
      // validates, so an app set up for Oh Dear needs no change to answer us.
      const headersOut: Record<string, string> = {}
      if (config.healthSecret)
        headersOut['oh-dear-health-check-secret'] = config.healthSecret

      const response = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: headersOut })
      const rawBody = await response.text().catch(() => '')
      const parsed = ((): unknown => {
        try { return JSON.parse(rawBody) }
        catch { return null }
      })()
      const body = parsed as { status?: string, checks?: Record<string, boolean> } | null
      metadata = body?.checks ? { checks: body.checks } : {}

      const headers: Record<string, string> = {}
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })
      const evaluation = await evaluateAssertions({
        monitorId: monitor.id,
        subject: { statusCode: response.status, headers, body: rawBody, responseTimeMs: Math.round(performance.now() - startedAt) },
      })

      if (evaluation.count > 0) {
        // Field assertions are the health contract (docs/monitors/health-checks.md):
        // a non-2xx is down, otherwise every assertion (dot-path into the JSON
        // body, header, status code, ...) must pass. No top-level `status`
        // field is required - the assertions define what healthy means.
        if (!response.ok) {
          status = 'down'
          message = `Health endpoint returned ${response.status}`
        }
        else if (evaluation.passed) {
          status = 'up'
          message = 'All assertions passed'
        }
        else {
          status = 'down'
          message = evaluation.failures.join('; ')
        }
      }
      else if (isAppHealthReport(parsed)) {
        // spatie/laravel-health + Oh Dear schema: a list of named checks.
        // Kept below assertions so a monitor that defines its own contract
        // still wins, and above the legacy branch so `checkResults` is not
        // mistaken for a missing `status` field.
        if (!response.ok) {
          status = 'down'
          message = `Health endpoint returned ${response.status}`
        }
        else {
          const verdict = evaluateAppHealth(parsed, Date.now(), config.healthMaxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS)
          status = verdict.status
          message = verdict.message
          metadata = {
            appHealth: {
              checks: verdict.checks,
              stale: verdict.stale,
              finishedAt: verdict.finishedAtMs ? new Date(verdict.finishedAtMs).toISOString() : null,
            },
          }
        }
      }
      else if (!response.ok || !body?.status) {
        // Legacy contract for monitors with no assertions: a top-level
        // `status` field drives the verdict.
        status = 'down'
        message = `Health endpoint returned ${response.status}${body?.status ? '' : ' with no status field'}`
      }
      else if (body.status === 'ok') {
        status = 'up'
        message = 'Healthy'
      }
      else if (body.status === 'degraded') {
        status = 'degraded'
        message = 'Degraded'
      }
      else {
        status = 'down'
        message = `Reported status: ${body.status}`
      }
    }
    catch (error) {
      status = 'down'
      message = error instanceof Error ? error.message : String(error)
    }

    const responseTimeMs = Math.round(performance.now() - startedAt)

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: responseTimeMs,
      status_code: null,
      message,
      metadata: JSON.stringify(metadata),
      region: process.env.WORKER_REGION || 'default',
      checked_at: checkedAt,
    })

    // Status + incident transitions are owned centrally by
    // EvaluateMonitorConsensus (cross-region agreement); this job just records
    // the region observation above and advances last_checked_at.
    await monitor.update({ last_checked_at: checkedAt })
    // Push this check outcome to the live-status broadcaster so the
    // dashboard updates sub-second. Fire-and-forget; a no-op unless
    // Redis fan-out is enabled (the poller is the fallback).
    void broadcastMonitorUpdate(monitor.id)
  },
})
