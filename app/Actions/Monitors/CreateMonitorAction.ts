import { PAYMENT_REQUIRED } from '../../lib/http'
import { randomUUIDv7 } from 'bun'
import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { limitReachedMessage, planForTeam } from '../../../config/plans'
import { coerceCheckbox, heartbeatAttributesFor, isMonitorType } from '../../lib/monitorForm'
import HeartbeatMonitor from '../../Models/HeartbeatMonitor'
import Monitor from '../../Models/Monitor'

export default new Action({
  name: 'CreateMonitorAction',
  description: 'Create a monitor, enforcing the team\'s plan limit',

  async handle(request) {
    // Derive the owning team from the caller's credentials, never from the
    // request body: trusting a client-supplied team_id let an unauthenticated
    // or cross-team caller create monitors under (and burn the quota of) any
    // team (IDOR). A body team_id, if sent, must match the authenticated team.
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const requestedTeamId = request.get('team_id') != null ? Number(request.get('team_id')) : authTeamId
    if (requestedTeamId !== authTeamId)
      return response.forbidden('You do not have access to this team')

    const teamId = authTeamId

    const existingCount = (await Monitor.where('team_id', teamId).get()).length
    const { plan, limits } = await planForTeam(teamId)

    if (existingCount >= limits.monitors) {
      return response.json(
        { error: limitReachedMessage('monitors', limits.monitors, plan) },
        { status: PAYMENT_REQUIRED },
      )
    }

    const checkIntervalSeconds = Number(request.get('check_interval_seconds') ?? 60)
    if (checkIntervalSeconds < limits.checkIntervalFloorSeconds) {
      return response.json(
        { error: `Check interval must be at least ${limits.checkIntervalFloorSeconds}s on the ${plan} plan. Upgrade to check more frequently.` },
        { status: PAYMENT_REQUIRED },
      )
    }

    const type = request.get('type')
    const reportsMetrics = coerceCheckbox(request.get('reports_metrics'))

    const monitor = await Monitor.create({
      team_id: teamId,
      name: request.get('name'),
      url: request.get('url'),
      type,
      enabled: request.get('enabled') ?? true,
      check_interval_seconds: checkIntervalSeconds,
      config: request.get('config'),
      reports_metrics: reportsMetrics,
      // metrics_token is hidden:true, so the auto-CRUD layer strips it from
      // write bodies — nothing else would ever mint one, and a metrics
      // monitor created here could never receive an agent push.
      metrics_token: reportsMetrics ? randomUUIDv7().replace(/-/g, '') : undefined,
      status: 'unknown',
    })

    // A 'cron' monitor is inert without its heartbeat row: DispatchDueChecks
    // has no cron entry and CheckOverdueHeartbeats iterates HeartbeatMonitor,
    // so one created without it silently never alerts. Same pairing the
    // dashboard form does, via the same shared defaults.
    const heartbeat = isMonitorType(type) ? heartbeatAttributesFor(type, {
      expected_interval_seconds: request.get('expected_interval_seconds'),
      grace_seconds: request.get('grace_seconds'),
      cron_expression: request.get('cron_expression'),
    }) : null
    if (heartbeat) {
      await HeartbeatMonitor.create({
        monitor_id: monitor.id,
        ping_token: randomUUIDv7().replace(/-/g, ''),
        expected_interval_seconds: heartbeat.expected_interval_seconds,
        grace_seconds: heartbeat.grace_seconds,
        cron_expression: heartbeat.cron_expression,
      })
    }

    return response.json(monitor, { status: 201 })
  },
})
