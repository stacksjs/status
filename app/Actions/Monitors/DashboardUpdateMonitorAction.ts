import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { randomUUIDv7 } from 'bun'
import { planForTeam } from '../../../config/plans'
import { parseMonitorForm } from '../../lib/monitorForm'
import HeartbeatMonitor from '../../Models/HeartbeatMonitor'
import Monitor from '../../Models/Monitor'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * Edit a monitor from the dashboard form. Same validation as create; the
 * monitor is fetched team-scoped so a guessed id from another team 403s
 * rather than being patched.
 */
export default new Action({
  name: 'DashboardUpdateMonitorAction',
  description: 'Update a monitor from the dashboard form',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const monitorId = Number(request.get('monitorId'))
    if (!Number.isInteger(monitorId) || monitorId <= 0)
      return response.json({ error: 'A monitor id is required' }, { status: 422 })

    const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
    if (!monitor)
      return response.forbidden('You do not have access to this monitor')

    const back = (query: string) => new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitorId}${query}` } })

    const parsed = parseMonitorForm({
      name: request.get('name'),
      url: request.get('url'),
      type: request.get('type'),
      enabled: request.get('enabled'),
      check_interval_seconds: request.get('check_interval_seconds'),
      reports_metrics: request.get('reports_metrics'),
      port: request.get('port'),
      path: request.get('path'),
      // Both forms have rendered these two since the health type shipped and
      // neither action read them, so buildMonitorConfig always saw undefined
      // and dropped them: the health endpoint secret could not be set from
      // the UI at all, at any monitor type. The field accepted input, saved
      // without complaint, and came back empty. Everything either side of
      // this line was already in place — monitorForm.ts builds the config
      // keys, RunHealthCheck sends the oh-dear-health-check-secret header.
      health_secret: request.get('health_secret'),
      health_max_age_seconds: request.get('health_max_age_seconds'),
      ping_count: request.get('ping_count'),
      packet_loss_threshold_percent: request.get('packet_loss_threshold_percent'),
      latency_threshold_ms: request.get('latency_threshold_ms'),
      full_scan: request.get('full_scan'),
      expected_ports: request.get('expected_ports'),
      alert_on_fingerprint_change: request.get('alert_on_fingerprint_change'),
      origin_ip: request.get('origin_ip'),
      lighthouse_device: request.get('lighthouse_device'),
      cpu_threshold: request.get('cpu_threshold'),
      ram_threshold: request.get('ram_threshold'),
      disk_threshold: request.get('disk_threshold'),
      expected_interval_seconds: request.get('expected_interval_seconds'),
      grace_seconds: request.get('grace_seconds'),
      cron_expression: request.get('cron_expression'),
    })

    if (parsed.error)
      return back(`?error=${parsed.error}`)

    // The interval floor is a plan gate on edit too, otherwise a free-plan
    // team could create at the floor and then edit down to 10s.
    const { limits } = await planForTeam(authTeamId)
    if (parsed.values.check_interval_seconds < limits.checkIntervalFloorSeconds)
      return back(`?error=plan_interval&floor=${limits.checkIntervalFloorSeconds}`)

    await monitor.update({
      name: parsed.values.name,
      url: parsed.values.url,
      type: parsed.values.type,
      enabled: parsed.values.enabled,
      check_interval_seconds: parsed.values.check_interval_seconds,
      config: parsed.values.config,
      reports_metrics: parsed.values.reports_metrics,
      // Mint on first enable, keep thereafter: rotating the token on every
      // save would silently break an already-installed agent.
      ...(parsed.values.reports_metrics && !monitor.metrics_token
        ? { metrics_token: randomUUIDv7().replace(/-/g, '') }
        : {}),
    })

    // Keep the heartbeat row in step with the monitor's type: switching TO
    // cron needs one (without it the monitor can never alert), and an
    // existing one is updated in place so its ping token - which the
    // operator may already have wired into a cron job - survives the edit.
    if (parsed.values.type === 'cron' && parsed.heartbeat) {
      const existing = await HeartbeatMonitor.where('monitor_id', monitorId).first()
      if (existing) {
        await existing.update({
          expected_interval_seconds: parsed.heartbeat.expected_interval_seconds,
          grace_seconds: parsed.heartbeat.grace_seconds,
          cron_expression: parsed.heartbeat.cron_expression,
        })
      }
      else {
        await HeartbeatMonitor.create({
          monitor_id: monitorId,
          pingToken: randomUUIDv7().replace(/-/g, ''),
          expectedIntervalSeconds: parsed.heartbeat.expected_interval_seconds,
          graceSeconds: parsed.heartbeat.grace_seconds,
          cronExpression: parsed.heartbeat.cron_expression,
        })
      }
    }

    return back('?saved=1')
  },
})
