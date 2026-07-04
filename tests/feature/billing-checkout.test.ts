import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { handleWebhookEvent } from '@stacksjs/payments'
import CancelSubscriptionAction from '../../app/Actions/Billing/CancelSubscriptionAction'
import CreateCheckoutSessionAction from '../../app/Actions/Billing/CreateCheckoutSessionAction'
// Import for its module-level side effect only: registers the
// customer.subscription.* handlers with @stacksjs/payments so
// handleWebhookEvent below actually dispatches to
// upsertLocalSubscriptionFromStripe.
import '../../app/Actions/Billing/StripeWebhookAction'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id/user id space since Bun
// runs test files concurrently by default.
const TEAM_ID = 90004
const OWNER_EMAIL = 'billing-test-owner-90004@example.com'

// The billing actions resolve the team from the requester's credential
// (@stacksjs/auth's team resolution), never from the form field, so the fake request
// carries an optional bearer token; without one it is an unauthenticated
// caller.
function fakeRequest(fields: Record<string, string | undefined>, token?: string) {
  return {
    get: (key: string) => fields[key],
    bearerToken: () => token,
    cookies: { get: () => undefined },
  } as any
}

describe('Billing checkout (stacksjs/status#1 Phase 9)', () => {
  let ownerUserId: number
  // `teams.id` is autoincrement, not TEAM_ID itself — resolved in
  // beforeAll and read by every test below.
  let realTeamId: number
  // A real access token for the owner, minted through Auth so the
  // actions' credential-based team resolution sees an authenticated
  // owner of realTeamId.
  let ownerToken: string

  beforeAll(async () => {
    await db.insertInto('teams').values({ name: `Billing Test Team ${TEAM_ID}` }).execute()
    const team = await db.selectFrom('teams').where('name', '=', `Billing Test Team ${TEAM_ID}`).select(['id']).executeTakeFirst()
    realTeamId = Number(team!.id)

    await db.insertInto('users').values({ name: 'Billing Owner', email: OWNER_EMAIL, password: 'x'.repeat(10) }).execute()
    const user = await db.selectFrom('users').where('email', '=', OWNER_EMAIL).select(['id']).executeTakeFirst()
    ownerUserId = Number(user!.id)

    await db.insertInto('team_members').values({
      team_id: realTeamId,
      user_id: ownerUserId,
      role: 'owner',
      status: 'active',
      invited_email: OWNER_EMAIL,
    }).execute()

    // No refresh token: keeps cleanup to the single access-token row.
    const login = await Auth.loginUsingId(ownerUserId, { withRefreshToken: false })
    ownerToken = String(login!.token)
  })

  afterAll(async () => {
    await db.deleteFrom('oauth_access_tokens').where('user_id', '=', ownerUserId).execute()
    await db.deleteFrom('subscriptions').where('user_id', '=', ownerUserId).execute()
    await db.deleteFrom('team_members').where('team_id', '=', realTeamId).execute()
    await db.deleteFrom('teams').where('id', '=', realTeamId).execute()
    await db.deleteFrom('users').where('id', '=', ownerUserId).execute()
  })

  describe('CreateCheckoutSessionAction', () => {
    test('401s an unauthenticated request before reading any form fields', async () => {
      // The team is derived from the credential, not the form, so a
      // request with no token is rejected outright even with a team_id.
      const res = await CreateCheckoutSessionAction.handle(fakeRequest({ team_id: String(realTeamId) }))
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: string }).error).toBe('Authentication required')
    })

    test('403s when the posted team_id does not match the authed team', async () => {
      // The form field is only checked for parity with the credential's
      // team; a mismatch is a cross-team access attempt, not a lookup.
      const res = await CreateCheckoutSessionAction.handle(fakeRequest({ team_id: '999999999' }, ownerToken))
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe('You do not have access to this team')
    })

    test('resolves the authed owner and fails gracefully (not a crash) without live Stripe credentials', async () => {
      const res = await CreateCheckoutSessionAction.handle(fakeRequest({ team_id: String(realTeamId) }, ownerToken))
      // No live Stripe network access in this test environment (fake
      // key from tests/setup.ts) — the important assertion is that it
      // degrades to a redirect-with-error, not an unhandled throw.
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain(`/dashboard/settings/billing?team_id=${realTeamId}&error=`)
    })
  })

  describe('CancelSubscriptionAction', () => {
    test('401s an unauthenticated request before reading any form fields', async () => {
      const res = await CancelSubscriptionAction.handle(fakeRequest({ team_id: String(realTeamId) }))
      expect(res.status).toBe(401)
      expect(((await res.json()) as { error: string }).error).toBe('Authentication required')
    })

    test('403s when the posted team_id does not match the authed team', async () => {
      const res = await CancelSubscriptionAction.handle(fakeRequest({ team_id: '999999999' }, ownerToken))
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe('You do not have access to this team')
    })

    test('redirects with error=no_active_subscription when the authed owner has no active subscription row', async () => {
      const res = await CancelSubscriptionAction.handle(fakeRequest({ team_id: String(realTeamId) }, ownerToken))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe(`/dashboard/settings/billing?team_id=${realTeamId}&error=no_active_subscription`)
    })
  })

  describe('webhook sync (StripeWebhookAction -> upsertLocalSubscriptionFromStripe)', () => {
    const providerId = `sub_test_${TEAM_ID}`
    const customerId = `cus_test_${TEAM_ID}`

    test('customer.subscription.created inserts a local subscription row for the matching stripe_id', async () => {
      await db.updateTable('users').set({ stripe_id: customerId }).where('id', '=', ownerUserId).execute()

      const event = {
        type: 'customer.subscription.created',
        data: {
          object: {
            id: providerId,
            customer: customerId,
            status: 'active',
            cancel_at: null,
            metadata: { plan: 'pro' },
            items: { data: [{ price: { id: 'price_test' }, quantity: 1 }] },
          },
        },
      } as any

      const result = await handleWebhookEvent(event)
      expect(result.handled).toBe(true)

      const row = await db.selectFrom('subscriptions').where('provider_id', '=', providerId).selectAll().executeTakeFirst()
      expect(row?.plan).toBe('pro')
      expect(row?.provider_status).toBe('active')
      expect(Number(row?.user_id)).toBe(ownerUserId)
    })

    test('customer.subscription.deleted updates the SAME row (not a duplicate insert) and flips status', async () => {
      const event = {
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: providerId,
            customer: customerId,
            status: 'canceled',
            cancel_at: Math.floor(Date.now() / 1000),
            metadata: { plan: 'pro' },
            items: { data: [{ price: { id: 'price_test' }, quantity: 1 }] },
          },
        },
      } as any

      await handleWebhookEvent(event)

      const rows = await db.selectFrom('subscriptions').where('provider_id', '=', providerId).selectAll().execute()
      expect(rows.length).toBe(1)
      expect(rows[0]?.provider_status).toBe('canceled')
      expect(rows[0]?.ends_at).toBeTruthy()
    })

    test('an event for an unknown Stripe customer is a silent no-op, not an error', async () => {
      const event = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_unrelated',
            customer: 'cus_no_matching_local_user',
            status: 'active',
            cancel_at: null,
            metadata: {},
            items: { data: [] },
          },
        },
      } as any

      const result = await handleWebhookEvent(event)
      expect(result.handled).toBe(true)
      expect(result.errors).toBeUndefined()

      const row = await db.selectFrom('subscriptions').where('provider_id', '=', 'sub_unrelated').selectAll().executeTakeFirst()
      expect(row).toBeUndefined()
    })
  })
})
