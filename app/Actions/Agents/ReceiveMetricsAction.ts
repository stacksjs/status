import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import CheckResult from '../../Models/CheckResult'
import Incident from '../../Models/Incident'
import { aggregateHostStatus, describeBreaches, normalizeHost, readingsFromRows } from '../../lib/agentHosts'
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

    // Which machine this sample describes. Absent for agents predating the
    // field, which normalize to a single 'default' host and behave exactly as
    // they did before.
    const host = normalizeHost(request.get('host'))

    const thresholds = parseMetricsThresholds(monitor.config)
    const breaches = evaluateBreaches({ cpuPercent, ramPercent, diskPercent }, thresholds)
    const sampleStatus: 'up' | 'down' = breaches.length > 0 ? 'down' : 'up'
    const checkedAt = new Date().toISOString()

    await CheckResult.create({
      monitor_id: monitor.id,
      status: sampleStatus,
      message: breaches.length > 0 ? `Threshold breach on ${host}: ${breaches.join('; ')}` : `Agent metrics received from ${host}`,
      // breaches are persisted so the monitor's status can be recomputed from
      // the stored samples without re-evaluating thresholds that may since
      // have been edited.
      metadata: JSON.stringify({ host, cpuPercent, ramPercent, ramUsedMb, ramTotalMb, ...(hasDisk ? { diskPercent } : {}), breaches }),
      region: 'agent',
      checked_at: checkedAt,
    })

    // The monitor's status is the whole fleet's, not this sample's. With two
    // hosts pushing, taking the newest sample's verdict would flap the monitor
    // up and down once a minute as a breaching node and a healthy one take
    // turns reporting.
    const windowStart = new Date(Date.parse(checkedAt) - thresholds.windowSeconds * 1000).toISOString()
    const recent = await CheckResult.where('monitor_id', monitor.id)
      .where('region', 'agent')
      .where('checked_at', '>=', windowStart)
      .orderBy('checked_at', 'desc')
      .orderBy('id', 'desc')
      .get()

    const fleet = aggregateHostStatus(readingsFromRows(recent), Date.parse(checkedAt), thresholds.windowSeconds)
    const status = fleet.status

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
        // Named per host: "CPU 96% ≥ 90%" across a fleet does not say which
        // machine to open a shell on, which is the first thing the person
        // being woken up needs.
        cause: `Host resource threshold breached: ${describeBreaches(fleet.breaching)}`,
        status: 'investigating',
        impacted_checks: JSON.stringify([{
          type: 'server_metrics',
          hosts: fleet.breaching.map(reading => ({ host: reading.host, breaches: reading.breaches })),
        }]),
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

    // `status` is the fleet's verdict and `sampleStatus` is this host's own,
    // which differ whenever another node is breaching. An agent that only saw
    // the fleet verdict could not tell whether it was the problem.
    return { success: true, status, host, sampleStatus, breaches, hosts: fleet.hosts.length }
  },
})
