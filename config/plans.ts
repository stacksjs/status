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

export default PLAN_LIMITS
