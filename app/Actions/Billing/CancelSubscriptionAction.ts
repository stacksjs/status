import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { manageSubscription } from '@stacksjs/payments'
import { response } from '@stacksjs/router'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { getTeamOwnerUserId } from '../../../config/plans'

/**
 * `POST /billing-forms/cancel` — cancels the team owner's active Stripe
 * subscription immediately (stacksjs/status#1 Phase 9). Local
 * `subscriptions` row is left for StripeWebhookAction's
 * `customer.subscription.deleted` event to update (provider_status ->
 * 'canceled') — this action doesn't race-write it itself, avoiding a
 * local/Stripe state split if the Stripe call succeeds but this
 * process crashes before writing.
 *
 * `manageSubscription.cancel(subscriptionId)` takes a plain Stripe
 * subscription id, not a model instance — sidesteps the billable-trait
 * instance-method gap CreateCheckoutSessionAction's doc comment
 * describes.
 *
 * team_id used to be taken from a form field with no verification at
 * all — any signed-in user could cancel another team's subscription by
 * posting a different team_id. It's now derived from the requester's
 * own session/token (see @stacksjs/auth's team resolution); the form field is only
 * checked for parity with it.
 */
export default new Action({
  name: 'CancelSubscriptionAction',
  description: "Cancel the team owner's active paid subscription",

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

    const subscription = await db
      .selectFrom('subscriptions')
      .where('user_id', '=', ownerUserId)
      .where('provider_status', '=', 'active')
      .orderBy('id', 'desc')
      .select(['provider_id'])
      .executeTakeFirst()

    if (!subscription?.provider_id)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=no_active_subscription` } })

    try {
      await manageSubscription.cancel(String(subscription.provider_id))
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&error=${encodeURIComponent(message)}` } })
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/settings/billing?team_id=${teamId}&cancelled=1` } })
  },
})
