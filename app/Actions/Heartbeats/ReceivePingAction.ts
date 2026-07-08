import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { isPingKind, runDurationSeconds } from '../../lib/heartbeat'
import { openIncident } from '../../lib/maintenance'
import HeartbeatMonitor from '../../Models/HeartbeatMonitor'
import Incident from '../../Models/Incident'
import IncidentUpdate from '../../Models/IncidentUpdate'
import Monitor from '../../Models/Monitor'
import { broadcastMonitorUpdate } from '../../Realtime/broadcastMonitorUpdate'

/**
 * Public, unauthenticated endpoint the customer's cron job / scheduled task
 * pings. The token is an unguessable random string (HeartbeatMonitor.pingToken),
 * not a numeric id, so there's nothing to enumerate or authenticate — matching
 * the Oh Dear / Healthchecks.io convention.
 *
 *   GET|POST /ping/{token}          success — the run finished
 *   GET|POST /ping/{token}/start    the run began (measures duration, arms the
 *                                    overrun deadline)
 *   GET|POST /ping/{token}/fail     the run errored — go down immediately
 *
 * A success ping also recovers a monitor that had gone down (missed check-in,
 * overrun, or a prior /fail): heartbeats are not a consensus type, so this is
 * the only place their incidents get resolved.
 */
export default new Action({
  name: 'ReceivePingAction',
  description: 'Record a heartbeat ping (success, start, or fail) for a scheduled-task monitor',

  async handle(request) {
    const token = request.get('token')
    const kind = request.get('kind')

    // /ping/{token}/{kind} only accepts the known sub-kinds; a stray path such
    // as /ping/{token}/anything must not be silently treated as a success.
    if (kind !== undefined && !isPingKind(kind))
      return response.json({ success: false, message: 'Unknown ping kind' }, { status: 404 })

    const heartbeat = await HeartbeatMonitor.where('ping_token', token).first()
    if (!heartbeat)
      return response.json({ success: false, message: 'Unknown ping token' }, { status: 404 })

    const now = new Date().toISOString()

    // A start ping only arms tracking; it never changes monitor status. The
    // overrun deadline (start + grace) is enforced by CheckOverdueHeartbeats.
    if (kind === 'start') {
      await heartbeat.update({ last_started_at: now })
      return { success: true, recorded: 'start' }
    }

    const monitor = await Monitor.find(heartbeat.monitor_id)

    if (kind === 'fail') {
      await heartbeat.update({ last_fail_at: now })
      if (monitor && monitor.status !== 'down') {
        await monitor.update({ status: 'down', last_checked_at: now })
        void broadcastMonitorUpdate(monitor.id)
        await openIncident({
          monitor_id: monitor.id,
          started_at: now,
          cause: `Scheduled task '${monitor.name}' reported a failure`,
          status: 'investigating',
          impacted_checks: JSON.stringify([{ type: 'cron', signal: 'fail' }]),
        })
      }
      return { success: true, recorded: 'fail' }
    }

    // Success ping: stamp the arrival, measure duration against any open run,
    // and recover the monitor if it was down.
    const startedAtMs = heartbeat.last_started_at ? Date.parse(heartbeat.last_started_at) : null
    const duration = runDurationSeconds(Number.isFinite(startedAtMs as number) ? startedAtMs : null, Date.parse(now))
    await heartbeat.update(duration == null ? { last_ping_at: now } : { last_ping_at: now, last_duration_seconds: duration })

    if (monitor && monitor.status === 'down') {
      await monitor.update({ status: 'up', last_checked_at: now })
      void broadcastMonitorUpdate(monitor.id)
      const open = await Incident.where('monitor_id', monitor.id)
        .where('status', '!=', 'resolved')
        .orderByDesc('created_at')
        .first()
      if (open) {
        await open.update({ status: 'resolved', resolved_at: now })
        await IncidentUpdate.create({
          incident_id: open.id,
          message: 'Scheduled task checked in again - monitor recovered.',
          status: 'resolved',
          posted_at: now,
        })
      }
    }

    return { success: true, recorded: 'success' }
  },
})
