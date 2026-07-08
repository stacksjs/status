import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import CheckResult from '../../Models/CheckResult'
import Incident from '../../Models/Incident'
import { openIncident } from '../../lib/maintenance'
import IncidentUpdate from '../../Models/IncidentUpdate'
import Monitor from '../../Models/Monitor'
import { broadcastMonitorUpdate } from '../../Realtime/broadcastMonitorUpdate'
import { evaluateBreaches, parseMetricsThresholds } from './metricsThresholds'

function isValidPercent(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100
}

function isValidMb(n: number): boolean {
  return Number.isFinite(n) && n >= 0
}

/**
 * Public, unauthenticated endpoint a customer's own monitored server pushes
 * CPU/RAM(/disk) samples to: POST /agent/{token}/metrics. The token is an
 * unguessable random string (Monitor.metricsToken), not a numeric id — same
 * convention as ReceivePingAction's ping_token.
 *
 * Each push is evaluated against the monitor's alert thresholds (config
 * JSON, see metricsThresholds.ts): a breach marks the host `down` and opens
 * an Incident (which fans out to the monitor's notification channels via the
 * incident:created observer); a healthy sample marks it `up` and resolves an
 * open incident. A CheckResult is recorded either way so the existing
 * per-monitor chart/history machinery picks it up.
 */
export default new Action({
  name: 'ReceiveMetricsAction',
  description: 'Record a pushed CPU/RAM/disk metrics sample and alert on threshold breaches',

  async handle(request) {
    const token = request.get('token')
    const monitor = await Monitor.where('metrics_token', token).first()

    if (!monitor)
      return response.json({ success: false, message: 'Unknown metrics token' }, { status: 404 })

    const cpuPercent = Number(request.get('cpuPercent'))
    const ramPercent = Number(request.get('ramPercent'))
    const ramUsedMb = Number(request.get('ramUsedMb'))
    const ramTotalMb = Number(request.get('ramTotalMb'))
    // Disk is optional — only agents that report it get disk alerting.
    const rawDisk = request.get('diskPercent')
    const hasDisk = rawDisk !== undefined && rawDisk !== null && rawDisk !== ''
    const diskPercent = hasDisk ? Number(rawDisk) : null

    if (!isValidPercent(cpuPercent) || !isValidPercent(ramPercent) || !isValidMb(ramUsedMb) || !isValidMb(ramTotalMb) || (hasDisk && !isValidPercent(diskPercent as number))) {
      return response.json(
        { success: false, message: 'cpuPercent/ramPercent/diskPercent must be 0-100, ramUsedMb/ramTotalMb must be >= 0' },
        { status: 422 },
      )
    }

    const thresholds = parseMetricsThresholds(monitor.config)
    const breaches = evaluateBreaches({ cpuPercent, ramPercent, diskPercent }, thresholds)
    const status: 'up' | 'down' = breaches.length > 0 ? 'down' : 'up'
    const checkedAt = new Date().toISOString()

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      message: breaches.length > 0 ? `Threshold breach: ${breaches.join('; ')}` : 'Agent metrics received',
      metadata: JSON.stringify({ cpuPercent, ramPercent, ramUsedMb, ramTotalMb, ...(hasDisk ? { diskPercent } : {}) }),
      region: 'agent',
      checked_at: checkedAt,
    })

    const prev = monitor.status
    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    void broadcastMonitorUpdate(monitor.id)

    // Open on the down-transition, resolve on recovery — same shape as the
    // other monitor jobs so a metrics alert shows up in incident history and
    // notifications exactly like an uptime outage.
    if (prev !== 'down' && status === 'down') {
      await openIncident({
        monitor_id: monitor.id,
        started_at: checkedAt,
        cause: `Host resource threshold breached: ${breaches.join('; ')}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{ type: 'server_metrics', breaches }]),
      })
    }
    else if (prev === 'down' && status === 'up') {
      const existingIncident = await Incident.where('monitor_id', monitor.id)
        .where('status', '!=', 'resolved')
        .orderByDesc('created_at')
        .first()
      if (existingIncident) {
        await existingIncident.update({ status: 'resolved', resolved_at: checkedAt })
        await IncidentUpdate.create({
          incident_id: existingIncident.id,
          message: 'Host resource usage back within thresholds.',
          status: 'resolved',
          posted_at: checkedAt,
        })
      }
    }

    return { success: true, status, breaches }
  },
})
