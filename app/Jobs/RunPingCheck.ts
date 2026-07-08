import { spawn } from 'node:child_process'
import process from 'node:process'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { applyPingDegradation, type CheckStatus, configNumber, parseMonitorConfig } from '../lib/monitorConfig'
import CheckResult from '../Models/CheckResult'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * Shells out to the system `ping` binary — Bun/Node have no raw ICMP socket
 * API without root, and `ping` is universally available on the platforms
 * this runs on (Linux/macOS worker images). Distinguishes "host unreachable"
 * from a closed port, which is what ping monitoring is for: telling a
 * customer whether an outage is at the network/host level or the
 * application level (paired with a TCP/uptime check on the same host).
 */
function ping(host: string, count: number): Promise<{ alive: boolean, timeMs: number | null, lossPercent: number | null }> {
  return new Promise((resolve) => {
    const isLinux = process.platform === 'linux'
    const args = isLinux ? ['-c', String(count), '-W', '5', host] : ['-c', String(count), '-t', '5', host]
    const child = spawn('ping', args)

    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })

    child.on('close', (code) => {
      // "X% packet loss" appears on both Linux and macOS summaries.
      const lossMatch = output.match(/([\d.]+)% packet loss/i)
      const lossPercent = lossMatch ? Number.parseFloat(lossMatch[1]!) : null
      // Prefer the average from the round-trip summary; fall back to the
      // first per-packet time when only one reply came back.
      const avgMatch = output.match(/=\s*[\d.]+\/([\d.]+)\//)
      const firstTime = output.match(/time[=<]([\d.]+)/i)
      const timeMs = avgMatch ? Number.parseFloat(avgMatch[1]!) : firstTime ? Number.parseFloat(firstTime[1]!) : null

      // `ping` exits non-zero only when EVERY packet is lost — a hard down.
      // Any reply (even with partial loss) exits 0 and stays 'alive'.
      if (code !== 0) {
        resolve({ alive: false, timeMs, lossPercent: lossPercent ?? 100 })
        return
      }
      resolve({ alive: true, timeMs, lossPercent })
    })

    child.on('error', () => resolve({ alive: false, timeMs: null, lossPercent: 100 }))
  })
}

export default new Job({
  name: 'RunPingCheck',
  description: 'ICMP ping check for a monitor',
  queue: 'checks',
  tries: 2,
  backoff: 10,
  timeout: 20,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunPingCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let host = monitor.url
    try {
      host = new URL(monitor.url).hostname
    }
    catch {
      // monitor.url is already a bare host (no scheme) — use as-is
    }

    const cfg = parseMonitorConfig(monitor.config)
    const pingCount = Math.max(1, Math.min(10, configNumber(cfg, 'pingCount', 3) || 3))
    const rttThresholdMs = configNumber(cfg, 'latencyThresholdMs', 0)
    const lossThresholdPercent = configNumber(cfg, 'packetLossThresholdPercent', 0)

    const checkedAt = new Date().toISOString()
    const result = await ping(host, pingCount)
    let status: CheckStatus = result.alive ? 'up' : 'down'
    let message = result.alive ? 'Host reachable' : 'Host unreachable'

    // Reachable-but-degraded: too much packet loss, or RTT over the
    // threshold (config `packetLossThresholdPercent` / `latencyThresholdMs`,
    // 0 disables each).
    const deg = applyPingDegradation(status, result.timeMs, result.lossPercent, { rttThresholdMs, lossThresholdPercent })
    if (deg.status !== status) {
      status = deg.status
      message = `Host reachable but degraded: ${deg.reason}`
    }

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: result.timeMs != null ? Math.round(result.timeMs) : null,
      status_code: null,
      message,
      metadata: JSON.stringify({ lossPercent: result.lossPercent }),
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
