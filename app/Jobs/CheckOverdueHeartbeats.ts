import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import HeartbeatMonitor from '../Models/HeartbeatMonitor'
import { openIncident } from '../lib/maintenance'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

/**
 * Runs every minute (see app/Scheduler.ts). Unlike the other check types,
 * a heartbeat monitor is passive — there's nothing to poll, only a
 * deadline to watch: expectedIntervalSeconds + graceSeconds since the last
 * ping. A heartbeat with no ping yet (lastPingAt null) is treated as
 * overdue from its creation time, not exempted — a cron job that never
 * ran once is exactly the failure mode this check exists to catch.
 */
export default new Job({
  name: 'CheckOverdueHeartbeats',
  description: 'Open incidents for scheduled-task monitors that missed their expected ping',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const heartbeats = await HeartbeatMonitor.all()
    const now = Date.now()
    let overdue = 0

    for (const heartbeat of heartbeats) {
      const baseline = heartbeat.last_ping_at ? new Date(heartbeat.last_ping_at).getTime() : new Date(heartbeat.created_at).getTime()
      const deadline = baseline + (heartbeat.expected_interval_seconds + heartbeat.grace_seconds) * 1000
      if (now < deadline)
        continue

      const monitor = await Monitor.find(heartbeat.monitor_id)
      if (!monitor || monitor.status === 'down')
        continue

      await monitor.update({ status: 'down', last_checked_at: new Date().toISOString() })
      // Push this check outcome to the live-status broadcaster so the
      // dashboard updates sub-second. Fire-and-forget; a no-op unless
      // Redis fan-out is enabled (the poller is the fallback).
      void broadcastMonitorUpdate(monitor.id)
      await openIncident({
        monitor_id: monitor.id,
        started_at: new Date().toISOString(),
        cause: `Scheduled task '${monitor.name}' missed its expected check-in`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'cron', expectedIntervalSeconds: heartbeat.expected_interval_seconds }]),
      })
      overdue++
      log.warn(`[job] CheckOverdueHeartbeats: ${monitor.name} missed its check-in`)
    }

    if (overdue > 0)
      log.debug(`[job] CheckOverdueHeartbeats: ${overdue} monitor(s) overdue`)
  },
})
