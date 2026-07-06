import process from 'node:process'
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
  pro: {
    monitors: 100,
    statusPages: 10,
    checkIntervalFloorSeconds: 30,
  },
}

export const DEFAULT_PLAN = 'free'

/**
 * Self-hosted plan slug + limits. A self-hosted install (no billing
 * configured — see billingEnabled below) has nothing to upgrade *to*, so
 * enforcing tier caps on it would be nonsense: the marketing site
 * promises "your own install has no plan limits", and this is where that
 * promise is kept. Everything is unbounded except a low technical floor
 * on the check interval (a guard against a runaway sub-second schedule,
 * not a plan gate).
 */
export const SELF_HOSTED_PLAN = 'self-hosted'
export const SELF_HOSTED_LIMITS: PlanLimits = {
  monitors: Number.POSITIVE_INFINITY,
  statusPages: Number.POSITIVE_INFINITY,
  checkIntervalFloorSeconds: 10,
}

/**
 * Is this the hosted, billed service? Self-hosted installs leave Stripe
 * unconfigured; the presence of a secret key is the single signal that
 * this install actually charges for plans. When false, plan limits do
 * not apply (see planForTeam) — the whole tiering system is inert and
 * every team is effectively self-hosted/unlimited.
 */
export function billingEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY)
}

/** True for a limit that is not actually bounded (self-hosted). */
export function isUnlimited(value: number): boolean {
  return !Number.isFinite(value)
}

/**
 * User-facing message when a plan-gated create is rejected. Kept here so
 * every gated action (monitors, status pages, ...) speaks with one voice
 * — and, crucially, so the *top* plan says the honest thing. On Pro
 * there is no higher tier to "upgrade" to, so we point at the two real
 * escape hatches: self-host for unlimited, or talk to us.
 */
export function limitReachedMessage(resource: string, limit: number, plan: string): string {
  if (plan === PAID_PLAN) {
    return `You've reached the Pro plan limit of ${limit} ${resource}. `
      + `UptimeStatus is MIT licensed — self-host your own install for unlimited ${resource}, `
      + `or contact us to raise your limit.`
  }
  return `You've reached the Free plan limit of ${limit} ${resource}. Upgrade to Pro to add more.`
}

/** The one paid plan slug — kept as a named constant so the checkout
 * action, webhook handler, and billing page can't drift on the string. */
export const PAID_PLAN = 'pro'

/**
 * $9/mo for the one paid plan (stacksjs/status#1 Phase 9). A literal
 * here (not env-driven) since the price itself is a product decision
 * this app is making, not per-install config — unlike a Stripe Price
 * ID, which IS install-specific (see PLAN_STRIPE_PRICE_ID below).
 */
export const PAID_PLAN_PRICE_USD_CENTS = 900

/**
 * Optional: a pre-created Stripe recurring Price ID for the paid plan.
 * When set, checkout uses it directly (recommended for production —
 * gives a stable Price object in the Stripe dashboard for reporting).
 * When unset, CreateCheckoutSessionAction falls back to Stripe's
 * inline `price_data` (dynamically creates the Price at checkout time
 * from PAID_PLAN_PRICE_USD_CENTS) so checkout works immediately with
 * nothing more than a valid STRIPE_SECRET_KEY — no manual Stripe
 * dashboard setup required first.
 */
export const PLAN_STRIPE_PRICE_ID: string | undefined = process.env.STRIPE_PRICE_PRO

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
 * call sites. CreateCheckoutSessionAction reuses getTeamOwnerUserId
 * below rather than duplicating the TeamMember lookup.
 */
export interface ResolvedPlan {
  /** Plan slug: 'self-hosted' | 'free' | 'pro'. */
  plan: string
  limits: PlanLimits
}

/**
 * Resolve a team's plan slug and limits in one place. Self-hosted
 * installs (billing off) short-circuit to unlimited before any DB work.
 * Every plan-gated action calls this so the owner/subscription lookup,
 * and the self-hosted escape hatch, can't drift between call sites.
 */
export async function planForTeam(teamId: number): Promise<ResolvedPlan> {
  if (!billingEnabled())
    return { plan: SELF_HOSTED_PLAN, limits: SELF_HOSTED_LIMITS }

  const ownerUserId = await getTeamOwnerUserId(teamId)
  if (!ownerUserId)
    return { plan: DEFAULT_PLAN, limits: PLAN_LIMITS[DEFAULT_PLAN]! }

  // Subscription has no useTimestamps trait (see its model definition) —
  // order by id (autoIncrement) as the "most recent" proxy instead.
  const subscription = await Subscription.where('user_id', ownerUserId).orderByDesc('id').first()
  const plan = subscription?.plan
  if (!plan || !(plan in PLAN_LIMITS))
    return { plan: DEFAULT_PLAN, limits: PLAN_LIMITS[DEFAULT_PLAN]! }

  return { plan, limits: PLAN_LIMITS[plan]! }
}

export async function planLimitsForTeam(teamId: number): Promise<PlanLimits> {
  return (await planForTeam(teamId)).limits
}

export async function getTeamOwnerUserId(teamId: number): Promise<number | null> {
  const owner = await TeamMember.where('team_id', teamId).where('role', 'owner').where('status', 'active').first()
  return owner?.user_id ?? null
}

export default PLAN_LIMITS
