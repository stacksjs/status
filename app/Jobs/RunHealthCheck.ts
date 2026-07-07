import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import EvaluateAssertionsAction from '../Actions/Assertions/EvaluateAssertionsAction'
import CheckResult from '../Models/CheckResult'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * Application health monitoring contract: the target app exposes a JSON
 * health endpoint (default the monitor's own URL — set monitor.config.path
 * to point at e.g. "/health" instead) returning:
 *
 *   { "status": "ok" | "degraded" | "down", "checks"?: { [name]: boolean } }
 *
 * `checks` is optional structured detail (disk space, queue depth, a
 * downstream API reachability flag, ...) surfaced in the CheckResult
 * message for diagnosis; only `status` drives the up/down/degraded state
 * and incident lifecycle.
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

    let config: { path?: string } = {}
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

      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      const rawBody = await response.text().catch(() => '')
      const body = ((): { status?: string, checks?: Record<string, boolean> } | null => {
        try { return JSON.parse(rawBody) }
        catch { return null }
      })()

      if (!response.ok || !body?.status) {
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
      metadata = body?.checks ? { checks: body.checks } : {}

      // Assertions (stacksjs/status#1 Phase 12) layer on top of the health
      // contract above — only evaluated when the endpoint itself already
      // reported healthy, same reasoning as RunUptimeCheck.
      if (status === 'up') {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value })

        const evaluation = await EvaluateAssertionsAction.handle({
          monitorId: monitor.id,
          subject: { statusCode: response.status, headers, body: rawBody, responseTimeMs: Math.round(performance.now() - startedAt) },
        })

        if (!evaluation.passed) {
          status = 'down'
          message = evaluation.failures.join('; ')
        }
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
