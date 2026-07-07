import { spawn } from 'node:child_process'
import process from 'node:process'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
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
function ping(host: string): Promise<{ alive: boolean, timeMs: number | null }> {
  return new Promise((resolve) => {
    const isLinux = process.platform === 'linux'
    const args = isLinux ? ['-c', '1', '-W', '5', host] : ['-c', '1', '-t', '5', host]
    const child = spawn('ping', args)

    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })

    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ alive: false, timeMs: null })
        return
      }
      const match = output.match(/time[=<]([\d.]+)/i)
      resolve({ alive: true, timeMs: match ? Number.parseFloat(match[1]!) : null })
    })

    child.on('error', () => resolve({ alive: false, timeMs: null }))
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

    const checkedAt = new Date().toISOString()
    const result = await ping(host)
    const status = result.alive ? 'up' : 'down'

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      response_time_ms: result.timeMs != null ? Math.round(result.timeMs) : null,
      status_code: null,
      message: result.alive ? 'Host reachable' : 'Host unreachable',
      metadata: JSON.stringify({}),
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
