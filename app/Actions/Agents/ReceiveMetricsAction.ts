import type { ServerStatus } from '../../lib/agentHosts'
import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { transaction } from '@stacksjs/orm'
import { response } from '@stacksjs/router'
import Monitor from '../../Models/Monitor'
import { aggregateHostStatus, normalizeHost, readingsFromSamples, serverStatusFromFleet } from '../../lib/agentHosts'
import { reconcileServerIncidents } from '../../lib/serverIncidents'
import { legacyReceiveMetrics } from './legacyReceiveMetrics'
import { evaluateBreaches, thresholdsForServer } from './metricsThresholds'

function isValidPercent(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 100
}

function isValidMb(n: number): boolean {
  return Number.isFinite(n) && n >= 0
}

/**
 * Public, unauthenticated: POST /api/agent/{token}/metrics. The token is
 * Server.metricsToken — unguessable, unique, and the whole credential (same
 * convention as HeartbeatMonitor.pingToken).
 *
 * Writes a ServerMetricSample, recomputes the box's fleet verdict (the latest
 * reading per fresh host; hot if any of them breaches), writes servers.status
 * and servers.last_sample_at in the same transaction as the insert, then
 * reconciles the box's own two incidents from that state.
 *
 * It never touches a Monitor: a sample says the box is busy or fine and
 * nothing about whether any site on it answers, so monitors.status,
 * monitors.last_checked_at and monitors.consecutive_failures all keep exactly
 * one writer — their own checks. (That is also why the monitor-49
 * probe-starvation guard that used to live here is gone: there is no probe
 * clock left to starve.)
 */
export default new Action({
  name: 'ReceiveMetricsAction',
  description: 'Record a pushed CPU/RAM/disk sample for a server and alert on threshold breaches',

  async handle(request) {
    const token = request.get('token')
    const server = await db.selectFrom('servers').where('metrics_token', '=', token).selectAll().executeTakeFirst()

    if (!server) {
      // Pre-backfill coexistence (ship step 2 only): the token is still on the
      // monitor, so delegate to the old monitor-keyed path unchanged. `buddy
      // servers:migrate` moves it; after that every live token resolves above
      // and this branch is unreachable, and step 6 deletes it.
      const legacy = await Monitor.where('metrics_token', token).first()
      if (legacy)
        return legacyReceiveMetrics(request, legacy)

      return response.json({ success: false, message: 'Unknown metrics token' }, { status: 404 })
    }

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
    // field, which normalize to a single 'default' host.
    const host = normalizeHost(request.get('host'))

    const thresholds = thresholdsForServer(server)
    const breaches = evaluateBreaches({ cpuPercent, ramPercent, diskPercent }, thresholds)
    // This host's own verdict, which is not the box's: 'degraded' says it
    // breached a threshold while still answering, never 'down'.
    const sampleStatus: 'up' | 'degraded' = breaches.length > 0 ? 'degraded' : 'up'
    const sampledAt = new Date().toISOString()
    const windowStart = new Date(Date.parse(sampledAt) - thresholds.windowSeconds * 1000).toISOString()

    // The insert, the fleet read and the status/baseline write are one
    // transaction (`transaction` from @stacksjs/orm; every statement through
    // `tx`, no model calls inside — they are a separate executor and are not
    // bound to the handle). last_sample_at is the missed-push baseline, and a
    // crash between the insert and the update must not leave a sample the
    // baseline does not know about.
    //
    // Within this process the framework serialises SQLite transactions, so two
    // pushes handled by the same web process cannot interleave here. Across
    // processes — the queue worker's CheckStaleServers tick is the only other
    // writer of servers.status — that tick's compare-and-set on last_sample_at
    // yields to a push that landed first.
    const { status, fleet } = await transaction(async (tx) => {
      await tx.insertInto('server_metric_samples').values({
        server_id: server.id,
        host,
        cpu_percent: cpuPercent,
        ram_percent: ramPercent,
        ram_used_mb: ramUsedMb,
        ram_total_mb: ramTotalMb,
        disk_percent: diskPercent,
        // Persisted so the fleet verdict can be recomputed from stored rows
        // without re-applying thresholds that may since have been edited.
        breaches: JSON.stringify(breaches),
        sampled_at: sampledAt,
        created_at: sampledAt,
      } as never).execute()

      // The box's status is the whole fleet's, not this sample's: two hosts
      // taking turns breaching would otherwise flap it once a minute.
      const recent = await tx.selectFrom('server_metric_samples')
        .where('server_id', '=', server.id)
        .where('sampled_at', '>=', windowStart)
        .orderBy('sampled_at', 'desc')
        .orderBy('id', 'desc')
        .selectAll()
        .execute()

      const aggregate = aggregateHostStatus(readingsFromSamples(recent), Date.parse(sampledAt), thresholds.windowSeconds)
      const next: ServerStatus = serverStatusFromFleet(aggregate)

      await tx.updateTable('servers')
        .set({ status: next, last_sample_at: sampledAt, updated_at: sampledAt })
        .where('id', '=', server.id)
        .execute()

      return { status: next, fleet: aggregate }
    })

    // State, not edge: a push is proof the agent is alive (so it closes any
    // open "agent went quiet"), 'healthy' closes any open "box is hot", and
    // 'hot' opens one or updates the one already open. Model calls, after the
    // commit on purpose, so incident:created / incident:updated fire normally.
    await reconcileServerIncidents({
      id: Number(server.id),
      team_id: Number(server.team_id),
      name: String(server.name),
      status,
      metrics_window_seconds: Number(server.metrics_window_seconds) || null,
    }, sampledAt, fleet)

    // `status` is the box's verdict and `sampleStatus` this host's own, which
    // differ whenever another node is breaching. An agent that only saw the
    // box verdict could not tell whether it was the problem.
    return { success: true, status, host, sampleStatus, breaches, hosts: fleet.hosts.length }
  },
})
