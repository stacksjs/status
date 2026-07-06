import type Stripe from 'stripe'
import { Action } from '@stacksjs/actions'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { constructEvent, handleWebhookEvent, onSubscription } from '@stacksjs/payments'
import { response } from '@stacksjs/router'
import { PAID_PLAN } from '../../../config/plans'
import User from '../../Models/User'

/**
 * `POST /billing-forms/webhook` — receives Stripe's `customer.
 * subscription.*` events and syncs the local `subscriptions` table so
 * planLimitsForTeam() reflects the real plan without polling Stripe on
 * every request (stacksjs/status#1 Phase 9).
 *
 * Uses raw db.insertInto/updateTable rather than the Subscription
 * model's Model.create()/update() — Subscription has `useUuid: true`
 * (see storage/framework/defaults/app/Models/Subscription.ts), and
 * this framework's uuid trait currently has no migration that actually
 * creates the column, so ORM-level create() throws "no such column
 * uuid" on a freshly migrated database. Raw queries bypass that
 * ORM-only codepath entirely — same workaround pattern used throughout
 * this app's auth/billing schema-guarantee fixes this session.
 *
 * Handler registration happens once, lazily, on the first request (see
 * `ensureHandlersRegistered`) — NOT at module top level. Registering at
 * import time called `onSubscription(...)` during the framework's
 * circular-import / async-module-evaluation window, before
 * @stacksjs/payments' `webhook.ts` had initialized its module-level
 * `handlers` map, throwing `Cannot access 'handlers' before
 * initialization` — which failed the WHOLE action import, so the router
 * dropped the webhook route entirely (POST /billing-forms/webhook 404'd).
 * A one-shot flag keeps the "register exactly once" guarantee (Stripe
 * re-hits this endpoint on every event; re-registering per request would
 * process each event N times) while deferring the call to a point where
 * every module is fully initialized.
 */

async function upsertLocalSubscriptionFromStripe(sub: Stripe.Subscription): Promise<void> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const user = await User.where('stripe_id', customerId).first()
  // No matching local user — e.g. a customer created outside this
  // app's checkout flow, or a stale test-mode event. Nothing to sync.
  if (!user) return

  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const plan = sub.metadata?.plan || PAID_PLAN

  const attrs = {
    user_id: user.id as number,
    type: 'default',
    plan,
    provider_id: sub.id,
    provider_status: sub.status,
    provider_price_id: priceId,
    provider_type: 'stripe',
    quantity: item?.quantity ?? 1,
    ends_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
  }

  const existing = await db.selectFrom('subscriptions').where('provider_id', '=', sub.id).select(['id']).executeTakeFirst()

  if (existing) {
    await db.updateTable('subscriptions').set(attrs).where('provider_id', '=', sub.id).execute()
  }
  else {
    await db.insertInto('subscriptions').values(attrs as never).execute()
  }
}

let handlersRegistered = false

/**
 * Register the subscription webhook handlers exactly once. Exported so
 * callers that drive `handleWebhookEvent` directly (e.g. feature tests)
 * can register without going through an HTTP round trip — production
 * registers lazily on the first `handle()` call.
 */
export function ensureHandlersRegistered(): void {
  if (handlersRegistered)
    return
  handlersRegistered = true
  onSubscription({
    created: event => upsertLocalSubscriptionFromStripe(event.data.object as Stripe.Subscription),
    updated: event => upsertLocalSubscriptionFromStripe(event.data.object as Stripe.Subscription),
    deleted: event => upsertLocalSubscriptionFromStripe(event.data.object as Stripe.Subscription),
  })
}

export default new Action({
  name: 'StripeWebhookAction',
  description: 'Receive and verify inbound Stripe webhook events, sync local subscriptions',
  method: 'POST',

  async handle(request: RequestInstance) {
    // Register the subscription handlers on first use (see the module
    // docblock for why this is lazy rather than at import time).
    ensureHandlersRegistered()

    const secret = config.services?.stripe?.webhookSecret
    if (!secret)
      return response.serverError('STRIPE_WEBHOOK_SECRET is not configured')

    const signature = request.headers.get('stripe-signature')
    if (!signature)
      return response.unauthorized('Missing stripe-signature header')

    // Must read the ORIGINAL (unparsed) body — Stripe's signature is
    // computed over the exact raw bytes it sent, and re-serializing a
    // JSON-parsed body would produce a different byte sequence
    // (whitespace/key-order) that fails verification even for a
    // legitimate event. bun-router clones the request before parsing
    // req.jsonBody (see parseRequestBody in stacks-router.ts), so the
    // original body stream here is untouched.
    const rawBody = await request.text()

    let event: Stripe.Event
    try {
      event = constructEvent(rawBody, signature, secret)
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return response.unauthorized(`Webhook signature verification failed: ${message}`)
    }

    const result = await handleWebhookEvent(event)
    return response.json(result)
  },
})
