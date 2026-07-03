import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { DEFAULT_PLAN, PLAN_LIMITS } from '../../../config/plans'
import Subscription from '../../../storage/framework/defaults/app/Models/Subscription'
import Monitor from '../../Models/Monitor'
import TeamMember from '../../Models/TeamMember'

/**
 * The built-in Subscription model is `belongsTo: ['User']`, not Team —
 * there's no such thing as "a team's plan" in the billing schema itself.
 * The product decision this app makes (stacksjs/status#1 Phase 9): a
 * team's plan is its *owner's* most recent Subscription. TeamMember (see
 * app/Models/TeamMember.ts) is what makes "who is this team's owner" a
 * real, queryable fact — it didn't exist before this phase, so this used
 * to be an unconditional DEFAULT_PLAN stub.
 *
 * Falls back to DEFAULT_PLAN whenever the chain is incomplete (no active
 * owner membership yet, or the owner has no Subscription row) — a team
 * mid-checkout or pre-billing-integration is treated as free-tier, not as
 * an error.
 */
async function planLimitFor(teamId: number): Promise<number> {
  const owner = await TeamMember.where('team_id', teamId).where('role', 'owner').where('status', 'active').first()
  if (!owner || !owner.user_id)
    return PLAN_LIMITS[DEFAULT_PLAN]!.monitors

  // Subscription has no useTimestamps trait (see its model definition) —
  // order by id (autoIncrement) as the "most recent" proxy instead.
  const subscription = await Subscription.where('user_id', owner.user_id).orderByDesc('id').first()
  const plan = subscription?.plan
  if (!plan || !(plan in PLAN_LIMITS))
    return PLAN_LIMITS[DEFAULT_PLAN]!.monitors

  return PLAN_LIMITS[plan]!.monitors
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
