#!/usr/bin/env bun
/**
 * Regional probe (stacksjs/status#1 Phase 11, push-probe topology).
 *
 * Runs on a remote check region's box (e.g. the Ashburn/us-east worker),
 * NOT on the primary. It is deliberately self-contained — no framework, no
 * database, no shared queue — so a new region is just this one file plus a
 * systemd timer. Each run:
 *
 *   1. GET  {PRIMARY_URL}/api/regions/{token}/monitors  → the monitors to probe
 *   2. runs the check locally from this region's network vantage point
 *   3. POST {PRIMARY_URL}/api/regions/{token}/results   → region-tagged results
 *
 * The primary's EvaluateMonitorConsensus job then weighs this region's vote
 * against the others. This box never decides up/down or touches incidents —
 * it only reports what it observed, exactly like the primary's own check
 * jobs (RunUptimeCheck / RunPingCheck / RunTcpPortCheck / RunHealthCheck),
 * whose status logic is mirrored below.
 *
 * Config (env):
 *   PRIMARY_URL             e.g. https://uptime-status.org   (required)
 *   REGIONAL_INGEST_TOKEN   shared secret with the primary   (required)
 *   WORKER_REGION           this region's tag, e.g. us-east  (default: us-east)
 *   PROBE_TIMEOUT_MS        per-check timeout                (default: 15000)
 *
 * Run once per invocation; schedule with a 60s systemd timer (see the
 * second-region runbook). Exit code is non-zero only on a fatal setup error
 * (missing config, primary unreachable) so the timer surfaces real outages
 * of the probe itself, not individual target-down results (those are data).
 */
import process from 'node:process'

const PRIMARY_URL = (process.env.PRIMARY_URL || '').replace(/\/+$/, '')
const TOKEN = process.env.REGIONAL_INGEST_TOKEN || ''
const REGION = process.env.WORKER_REGION || 'us-east'
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS) || 15_000

if (!PRIMARY_URL || !TOKEN) {
  console.error('[region-probe] PRIMARY_URL and REGIONAL_INGEST_TOKEN are required')
  process.exit(2)
}

type Status = 'up' | 'down' | 'degraded'

interface Monitor {
  id: number
  type: string
  url: string
  config: string | null
}

interface Result {
  monitor_id: number
  status: Status
  response_time_ms: number | null
  status_code: number | null
  message: string
  metadata: string
  checked_at: string
}

function parseConfig(raw: string | null): Record<string, unknown> {
  if (!raw)
    return {}
  try {
    return JSON.parse(raw)
  }
  catch {
    return {}
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  }
  catch {
    return url // already a bare host
  }
}

/** HTTP uptime check — mirrors RunUptimeCheck (2xx/3xx = up). */
async function checkUptime(monitor: Monitor): Promise<Result> {
  const startedAt = performance.now()
  let status: Status = 'down'
  let statusCode: number | undefined
  let message = ''
  try {
    const res = await fetch(monitor.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
    statusCode = res.status
    status = res.status >= 200 && res.status < 400 ? 'up' : 'down'
    message = status === 'up' ? 'OK' : `Unexpected status code ${res.status}`
  }
  catch (error) {
    status = 'down'
    message = error instanceof Error ? error.message : String(error)
  }
  return {
    monitor_id: monitor.id,
    status,
    response_time_ms: Math.round(performance.now() - startedAt),
    status_code: statusCode ?? 0,
    message,
    metadata: JSON.stringify({}),
    checked_at: new Date().toISOString(),
  }
}

/** JSON health check — mirrors RunHealthCheck (body.status ok/degraded). */
async function checkHealth(monitor: Monitor): Promise<Result> {
  const cfg = parseConfig(monitor.config) as { path?: string }
  const url = cfg.path ? new URL(cfg.path, monitor.url).toString() : monitor.url
  const startedAt = performance.now()
  let status: Status = 'down'
  let message = ''
  let metadata: Record<string, unknown> = {}
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    const raw = await res.text().catch(() => '')
    let body: { status?: string, checks?: Record<string, boolean> } | null = null
    try {
      body = JSON.parse(raw)
    }
    catch {
      body = null
    }
    if (!res.ok || !body?.status) {
      status = 'down'
      message = `Health endpoint returned ${res.status}${body?.status ? '' : ' with no status field'}`
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
  }
  catch (error) {
    status = 'down'
    message = error instanceof Error ? error.message : String(error)
  }
  return {
    monitor_id: monitor.id,
    status,
    response_time_ms: Math.round(performance.now() - startedAt),
    status_code: null,
    message,
    metadata: JSON.stringify(metadata),
    checked_at: new Date().toISOString(),
  }
}

/** TCP connect check — mirrors RunTcpPortCheck (config.port, default 443). */
async function checkTcpPort(monitor: Monitor): Promise<Result> {
  const cfg = parseConfig(monitor.config) as { port?: number }
  const port = typeof cfg.port === 'number' ? cfg.port : 443
  const host = hostOf(monitor.url)
  const startedAt = performance.now()

  const open = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean, socket?: { end: () => void }) => {
      if (settled)
        return
      settled = true
      try {
        socket?.end()
      }
      catch {}
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), TIMEOUT_MS)
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer)
          done(true, socket)
        },
        error() {
          clearTimeout(timer)
          done(false)
        },
        connectError() {
          clearTimeout(timer)
          done(false)
        },
        data() {},
        close() {},
      },
    }).catch(() => {
      clearTimeout(timer)
      done(false)
    })
  })

  return {
    monitor_id: monitor.id,
    status: open ? 'up' : 'down',
    response_time_ms: Math.round(performance.now() - startedAt),
    status_code: null,
    message: open ? `Port ${port} open` : `Port ${port} closed or unreachable`,
    metadata: JSON.stringify({ port }),
    checked_at: new Date().toISOString(),
  }
}

/** ICMP ping — mirrors RunPingCheck (host reachable). Uses the system ping. */
async function checkPing(monitor: Monitor): Promise<Result> {
  const host = hostOf(monitor.url)
  const startedAt = performance.now()
  // -c 1 one echo, -w/-W bound the wait. Linux ping: -w deadline (s).
  const proc = Bun.spawn(['ping', '-c', '1', '-w', String(Math.ceil(TIMEOUT_MS / 1000)), host], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const code = await proc.exited
  const alive = code === 0
  return {
    monitor_id: monitor.id,
    status: alive ? 'up' : 'down',
    response_time_ms: Math.round(performance.now() - startedAt),
    status_code: null,
    message: alive ? 'Host reachable' : 'Host unreachable',
    metadata: JSON.stringify({}),
    checked_at: new Date().toISOString(),
  }
}

async function runCheck(monitor: Monitor): Promise<Result | null> {
  switch (monitor.type) {
    case 'uptime': return checkUptime(monitor)
    case 'health': return checkHealth(monitor)
    case 'tcp_port': return checkTcpPort(monitor)
    case 'ping': return checkPing(monitor)
    default: return null // not a region-sensitive type; the primary owns it
  }
}

async function main() {
  const listUrl = `${PRIMARY_URL}/api/regions/${TOKEN}/monitors`
  const res = await fetch(listUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((e) => {
    console.error(`[region-probe] cannot reach primary: ${e}`)
    return null
  })
  if (!res || !res.ok) {
    console.error(`[region-probe] monitor list failed: ${res ? res.status : 'no response'}`)
    process.exit(1)
  }
  const body = await res.json() as { success: boolean, monitors: Monitor[] }
  const monitors = body.monitors || []
  console.error(`[region-probe] ${REGION}: probing ${monitors.length} monitor(s)`)

  // Bounded concurrency so a fleet of monitors doesn't open thousands of
  // sockets at once from a small box.
  const CONCURRENCY = 20
  const results: Result[] = []
  for (let i = 0; i < monitors.length; i += CONCURRENCY) {
    const batch = monitors.slice(i, i + CONCURRENCY)
    const settled = await Promise.all(batch.map(runCheck))
    for (const r of settled) {
      if (r)
        results.push(r)
    }
  }

  if (results.length === 0) {
    console.error('[region-probe] no region-sensitive monitors to report')
    return
  }

  const postUrl = `${PRIMARY_URL}/api/regions/${TOKEN}/results`
  const post = await fetch(postUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ region: REGION, results }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => {
    console.error(`[region-probe] result POST failed: ${e}`)
    return null
  })
  if (!post || !post.ok) {
    console.error(`[region-probe] ingest rejected: ${post ? post.status : 'no response'} ${post ? await post.text().catch(() => '') : ''}`)
    process.exit(1)
  }
  const summary = await post.json().catch(() => ({}))
  const up = results.filter(r => r.status === 'up').length
  console.error(`[region-probe] reported ${results.length} result(s) (${up} up) — ingest: ${JSON.stringify(summary)}`)
}

main().catch((e) => {
  console.error(`[region-probe] fatal: ${e}`)
  process.exit(1)
})
