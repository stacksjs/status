import process from 'node:process'
import { Action } from '@stacksjs/actions'
import { config } from '@stacksjs/config'
import { manageCustomer, stripe } from '@stacksjs/payments'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { PAID_PLAN, PAID_PLAN_PRICE_USD_CENTS, PLAN_STRIPE_PRICE_ID, getTeamOwnerUserId } from '../../../config/plans'
import User from '../../Models/User'

/**
 * `POST /billing-forms/checkout` — plain-POST, redirect-to-Stripe
 * counterpart to the framework's JSON CreateCheckoutAction, matching
 * this app's dashboard convention (native forms, redirect-back — see
 * DashboardCreateStatusPageAction's doc comment for why).
 *
 * Resolves the team's owner User (same getTeamOwnerUserId TeamMember
 * lookup planLimitsForTeam uses) and starts a Stripe subscription
 * checkout for the single paid plan. Uses manageCustomer +
 * stripe.checkout.sessions.create directly rather than the User
 * model's checkout()/billable trait wrapper: that wrapper only builds
 * `price` line items from a pre-created Stripe Price ID, but this
 * checkout needs to fall back to inline `price_data` when no
 * PLAN_STRIPE_PRICE_ID is configured (stacksjs/status#1 Phase 9) so
 * checkout works immediately with nothing more than STRIPE_SECRET_KEY.
 *
 * team_id used to be taken from a form field with no verification at
 * all — any signed-in user could start (and, on success, become the
 * billing contact for) another team's checkout by posting a different
 * team_id. It's now derived from the requester's own session/token
 * (see @stacksjs/auth's team resolution); the form field is only checked for parity
 * with it.
 */
export default new Action({
  name: 'CreateCheckoutSessionAction',
  description: 'Start a Stripe subscription checkout for the paid plan',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.json({ error: 'Authentication required' }, { status: 401 })

    const requestedTeamId = Number(request.get('team_id'))
    if (requestedTeamId && requestedTeamId !== authTeamId)
      return response.json({ error: 'You do not have access to this team' }, { status: 403 })

    const teamId = authTeamId
    const ownerUserId = await getTeamOwnerUserId(teamId)
    if (!ownerUserId)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=no_owner` } })

    const owner = await User.find(ownerUserId)
    if (!owner)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=no_owner` } })

    const appUrl = config.app?.url ? `https://${config.app.url}` : `http://localhost:${process.env.PORT || '3000'}`
    const successUrl = `${appUrl}/dashboard/settings/billing?team_id=${teamId}&checkout=success`
    const cancelUrl = `${appUrl}/dashboard/settings/billing?team_id=${teamId}&checkout=cancelled`

    let customer
    try {
      customer = await manageCustomer.createOrGetStripeUser(owner, {})
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=${encodeURIComponent(message)}` } })
    }

    const lineItem = PLAN_STRIPE_PRICE_ID
      ? { price: PLAN_STRIPE_PRICE_ID, quantity: 1 }
      : {
          price_data: {
            currency: 'usd',
            unit_amount: PAID_PLAN_PRICE_USD_CENTS,
            recurring: { interval: 'month' as const },
            product_data: { name: 'Status Pro' },
          },
          quantity: 1,
        }

    let session
    try {
      session = await stripe.checkout.sessions.create({
        customer: customer.id,
        mode: 'subscription',
        line_items: [lineItem],
        success_url: successUrl,
        cancel_url: cancelUrl,
        allow_promotion_codes: true,
        // Carries the plan slug through to the webhook so
        // StripeWebhookAction doesn't have to re-derive it from a
        // price id lookup — see PAID_PLAN's doc comment.
        metadata: { plan: PAID_PLAN, team_id: String(teamId) },
        subscription_data: { metadata: { plan: PAID_PLAN, team_id: String(teamId) } },
      })
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=${encodeURIComponent(message)}` } })
    }

    if (!session.url)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=no_checkout_url` } })

    return new Response(null, { status: 302, headers: { Location: session.url } })
  },
})
