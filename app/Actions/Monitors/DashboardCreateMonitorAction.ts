import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { randomUUIDv7 } from 'bun'
import { limitReachedMessage, planForTeam } from '../../../config/plans'
import { parseMonitorForm } from '../../lib/monitorForm'
import HeartbeatMonitor from '../../Models/HeartbeatMonitor'
import Monitor from '../../Models/Monitor'
import { resolveOrCreateTeamId } from '../../lib/teamContext'

/**
 * Create a monitor from the dashboard form (the no-JS counterpart to the
 * JSON CreateMonitorAction). Until this existed the monitors page told
 * operators to "create a monitor via the API", which meant the product
 * could not be set up without curl.
 *
 * Unlike the JSON action this validates every field, because a browser
 * form cannot render the router's 422 JSON: parseMonitorForm normalizes the
 * strings a form posts (checkbox "on", blank numerics) and this handler
 * adds the two checks that need the database — the team's plan limits.
 */
export default new Action({
  name: 'DashboardCreateMonitorAction',
  description: 'Create a monitor from the dashboard form',

  async handle(request) {
    const authTeamId = await resolveOrCreateTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const back = (query: string) => new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/new${query}` } })

    const parsed = parseMonitorForm({
      name: request.get('name'),
      url: request.get('url'),
      type: request.get('type'),
      enabled: request.get('enabled'),
      check_interval_seconds: request.get('check_interval_seconds'),
      reports_metrics: request.get('reports_metrics'),
      port: request.get('port'),
      path: request.get('path'),
      // See the same pair in DashboardUpdateMonitorAction: rendered by the
      // form, posted by the browser, read by neither action until now, so a
      // health monitor could never carry a secret.
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

    // Plan gates, mirroring CreateMonitorAction so both entry points enforce
    // the same quota (the form is not a way around the paywall).
    const existingCount = (await Monitor.where('team_id', authTeamId).get()).length
    const { limits } = await planForTeam(authTeamId)
    if (existingCount >= limits.monitors)
      return back(`?error=plan_monitors&limit=${limits.monitors}`)
    if (parsed.values.check_interval_seconds < limits.checkIntervalFloorSeconds)
      return back(`?error=plan_interval&floor=${limits.checkIntervalFloorSeconds}`)

    const monitor = await Monitor.create({
      teamId: authTeamId,
      name: parsed.values.name,
      url: parsed.values.url,
      type: parsed.values.type,
      enabled: parsed.values.enabled,
      checkIntervalSeconds: parsed.values.check_interval_seconds,
      config: parsed.values.config,
      reportsMetrics: parsed.values.reports_metrics,
      // The agent ingest credential is minted here because nothing else in
      // the app ever did: metrics_token is hidden:true, so the auto-CRUD
      // layer strips it from write bodies and a metrics monitor created
      // through the API could never receive a push.
      metrics_token: parsed.values.reports_metrics ? randomUUIDv7().replace(/-/g, '') : undefined,
      status: 'unknown',
    })

    // A 'cron' monitor is inert without its heartbeat row: DispatchDueChecks
    // has no cron entry and CheckOverdueHeartbeats iterates HeartbeatMonitor.
    if (parsed.values.type === 'cron' && parsed.heartbeat) {
      await HeartbeatMonitor.create({
        monitor_id: monitor.id,
        pingToken: randomUUIDv7().replace(/-/g, ''),
        expectedIntervalSeconds: parsed.heartbeat.expected_interval_seconds,
        graceSeconds: parsed.heartbeat.grace_seconds,
        cronExpression: parsed.heartbeat.cron_expression,
      })
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/monitors/${monitor.id}?created=1` } })
  },
})
