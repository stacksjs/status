import Subscription from '../storage/framework/defaults/app/Models/Subscription'
import TeamMember from '../app/Models/TeamMember'

/**
 * Pricing tier limits (stacksjs/status#1 Phase 9). Keyed by the
 * Subscription/Product plan slug — reuses the built-in commerce models
 * (Product, Subscription) rather than a bespoke billing schema; this file
 * is just the limits data those plans map to.
 */
export interface PlanLimits {
  monitors: number
  statusPages: number
  checkIntervalFloorSeconds: number
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: {
    monitors: 5,
    statusPages: 1,
    checkIntervalFloorSeconds: 300,
  },
  starter: {
    monitors: 25,
    statusPages: 3,
    checkIntervalFloorSeconds: 60,
  },
  pro: {
    monitors: 100,
    statusPages: 10,
    checkIntervalFloorSeconds: 30,
  },
}

export const DEFAULT_PLAN = 'free'

/**
 * The built-in Subscription model is `belongsTo: ['User']`, not Team —
 * there's no such thing as "a team's plan" in the billing schema itself.
 * The product decision this app makes: a team's plan is its *active
 * owner's* most recent Subscription (see app/Models/TeamMember.ts, the
 * pivot the built-in Team/User models never had). Falls back to
 * DEFAULT_PLAN whenever that chain is incomplete — no owner yet, or the
 * owner has no Subscription row — rather than erroring; a team
 * mid-checkout or pre-billing-integration is free-tier, not broken.
 *
 * Single source of truth for this resolution — every plan-gated create
 * action (monitors, status pages, ...) calls this rather than
 * re-deriving it, so the owner/subscription lookup can't drift between
 * call sites.
 */
export async function planLimitsForTeam(teamId: number): Promise<PlanLimits> {
  const owner = await TeamMember.where('team_id', teamId).where('role', 'owner').where('status', 'active').first()
  if (!owner || !owner.user_id)
    return PLAN_LIMITS[DEFAULT_PLAN]!

  // Subscription has no useTimestamps trait (see its model definition) —
  // order by id (autoIncrement) as the "most recent" proxy instead.
  const subscription = await Subscription.where('user_id', owner.user_id).orderByDesc('id').first()
  const plan = subscription?.plan
  if (!plan || !(plan in PLAN_LIMITS))
    return PLAN_LIMITS[DEFAULT_PLAN]!

  return PLAN_LIMITS[plan]!
}

export default PLAN_LIMITS
