import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { DEFAULT_PLAN, PLAN_LIMITS } from '../../../config/plans'
import Monitor from '../../Models/Monitor'

/**
 * Overrides the useApi-generated `POST /monitors` (user-defined routes in
 * routes/ take priority over auto-generated ones — see
 * storage/framework/core/orm/routes.ts) to enforce the plan's monitor
 * limit before creating.
 *
 * Every team is treated as being on DEFAULT_PLAN for now — there's no
 * billing integration wiring a team to a real Subscription yet (the
 * built-in Subscription model is `belongsTo: ['User']`, not Team, so
 * mapping "this team's active plan" needs a product decision — team
 * owner's subscription? a separate TeamSubscription pivot? — before it's
 * worth building. This function is the single place that decision plugs
 * into once made; everything else in this action is plan-agnostic.
 */
async function planLimitFor(_teamId: number): Promise<number> {
  return PLAN_LIMITS[DEFAULT_PLAN]!.monitors
}

export default new Action({
  name: 'CreateMonitorAction',
  description: 'Create a monitor, enforcing the team\'s plan limit',

  async handle(request) {
    const teamId = Number(request.get('team_id'))
    if (!teamId)
      return response.json({ error: 'team_id is required' }, { status: 422 })

    const existingCount = (await Monitor.where('team_id', teamId).get()).length
    const limit = await planLimitFor(teamId)

    if (existingCount >= limit) {
      return response.json(
        { error: `Monitor limit reached (${limit} on the current plan). Upgrade to add more.` },
        { status: 402 },
      )
    }

    const monitor = await Monitor.create({
      team_id: teamId,
      name: request.get('name'),
      url: request.get('url'),
      type: request.get('type'),
      enabled: request.get('enabled') ?? true,
      check_interval_seconds: request.get('check_interval_seconds') ?? 60,
      config: request.get('config'),
      status: 'unknown',
    })

    return response.json(monitor, { status: 201 })
  },
})
