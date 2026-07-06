import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { awaitConfig, config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import User from '../../app/Models/User'

// Regression test for the import-time TDZ that made StripeWebhookAction
// fail to load (so POST /billing-forms/webhook 404'd). Beyond "the route
// exists", this drives the whole path with a forged-but-valid Stripe
// signature: signature verification, the lazily-registered subscription
// handler, and the local upsert.
const WEBHOOK_SECRET = 'whsec_test_90011'
const CUSTOMER = 'cus_wh_90011'
const EMAIL = 'stripe-wh-90011@example.com'

// Compute Stripe's webhook signature header directly (its own SDK helper
// needs async SubtleCrypto in Bun): `t=<ts>,v1=<HMAC-SHA256(secret,
// "<ts>.<payload>")>`.
function signed(payload: string, secret = WEBHOOK_SECRET) {
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  return `t=${t},v1=${v1}`
}

function subscriptionEvent(subId: string, status: string) {
  return JSON.stringify({
    id: `evt_${subId}`,
    type: 'customer.subscription.created',
    data: {
      object: {
        id: subId,
        customer: CUSTOMER,
        status,
        items: { data: [{ price: { id: 'price_pro' }, quantity: 1 }] },
        metadata: { plan: 'pro' },
        cancel_at: null,
      },
    },
  })
}

describe('Stripe webhook (stacksjs/status#1 Phase 9 — import-crash regression)', () => {
  let userId: number
  let prevSecret: string | undefined

  beforeAll(async () => {
    await awaitConfig()
    const svc = (config as { services?: { stripe?: { webhookSecret?: string } } }).services
    prevSecret = svc?.stripe?.webhookSecret
    if (svc?.stripe)
      svc.stripe.webhookSecret = WEBHOOK_SECRET

    const user = await User.create({ name: 'WH User', email: EMAIL, password: 'a-real-password-1' })
    userId = user.id
    await db.updateTable('users').set({ stripe_id: CUSTOMER } as never).where('id', '=', userId).execute()
  })

  afterAll(async () => {
    const svc = (config as { services?: { stripe?: { webhookSecret?: string } } }).services
    if (svc?.stripe)
      svc.stripe.webhookSecret = prevSecret
    await db.deleteFrom('subscriptions').where('user_id', '=', userId).execute()
    await db.deleteFrom('users').where('id', '=', userId).execute()
  })

  test('the webhook route is registered (imports cleanly) and rejects a missing signature', async () => {
    const res = await featureTest().post('/api/billing-forms/webhook', subscriptionEvent('sub_nosig', 'active'))
    // 401 (missing stripe-signature) proves the action loaded and handle()
    // ran — the pre-fix bug made this a 404 (route never registered).
    expect(res.status).toBe(401)
  })

  test('a validly-signed subscription.created event upserts the local subscription', async () => {
    const body = subscriptionEvent('sub_created_90011', 'active')
    const res = await featureTest().withHeaders({ 'stripe-signature': signed(body) }).post('/api/billing-forms/webhook', body)
    expect(res.status).toBe(200)

    const row = await db.selectFrom('subscriptions').where('provider_id', '=', 'sub_created_90011').selectAll().executeTakeFirst() as { user_id?: number, provider_status?: string, plan?: string } | undefined
    expect(row).toBeTruthy()
    expect(Number(row?.user_id)).toBe(userId)
    expect(row?.provider_status).toBe('active')
    expect(row?.plan).toBe('pro')
  })

  test('a subsequent event for the same subscription updates in place (single row)', async () => {
    const body = subscriptionEvent('sub_created_90011', 'canceled')
    const res = await featureTest().withHeaders({ 'stripe-signature': signed(body) }).post('/api/billing-forms/webhook', body)
    expect(res.status).toBe(200)

    const rows = await db.selectFrom('subscriptions').where('provider_id', '=', 'sub_created_90011').selectAll().execute() as Array<{ provider_status?: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provider_status).toBe('canceled')
  })

  test('a tampered body fails signature verification', async () => {
    const body = subscriptionEvent('sub_tamper', 'active')
    const sig = signed(body)
    const res = await featureTest().withHeaders({ 'stripe-signature': sig }).post('/api/billing-forms/webhook', body.replace('sub_tamper', 'sub_evil'))
    expect(res.status).toBe(401)
  })
})
