import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { planLimitsForTeam } from '../../../config/plans'
import Monitor from '../../Models/Monitor'

export default new Action({
  name: 'CreateMonitorAction',
  description: 'Create a monitor, enforcing the team\'s plan limit',

  async handle(request) {
    const teamId = Number(request.get('team_id'))
    if (!teamId)
      return response.json({ error: 'team_id is required' }, { status: 422 })

    const existingCount = (await Monitor.where('team_id', teamId).get()).length
    const limits = await planLimitsForTeam(teamId)

    if (existingCount >= limits.monitors) {
      return response.json(
        { error: `Monitor limit reached (${limits.monitors} on the current plan). Upgrade to add more.` },
        { status: 402 },
      )
    }

    const checkIntervalSeconds = Number(request.get('check_interval_seconds') ?? 60)
    if (checkIntervalSeconds < limits.checkIntervalFloorSeconds) {
      return response.json(
        { error: `Check interval must be at least ${limits.checkIntervalFloorSeconds}s on the current plan. Upgrade to check more frequently.` },
        { status: 402 },
      )
    }

    const monitor = await Monitor.create({
      team_id: teamId,
      name: request.get('name'),
      url: request.get('url'),
      type: request.get('type'),
      enabled: request.get('enabled') ?? true,
      check_interval_seconds: checkIntervalSeconds,
      config: request.get('config'),
      status: 'unknown',
    })

    return response.json(monitor, { status: 201 })
  },
})
