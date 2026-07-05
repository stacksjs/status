import { describe, expect, test } from 'bun:test'
import { featureTest } from '@stacksjs/testing'

// Regression guard for the marketing-audit finding: the auto-generated
// REST API (useApi trait) leaves *read* routes (index/show) public by
// default — only writes get `auth` (see auto-crud.ts resolveApiMiddleware).
// Every sensitive model in app/Models now declares `middleware: ['auth']`
// on its useApi trait so an anonymous caller can't browse another team's
// monitors, check results, subscriber emails, webhook secrets, etc.
//
// These hit the real in-process router pipeline via featureTest(), so a
// regression (someone dropping the middleware, or the framework default
// silently changing) turns the 401 back into a 200 and fails here.
describe('Auto-CRUD API requires auth on reads (marketing audit)', () => {
  // Read-heavy endpoints that were world-readable before the fix. Not
  // exhaustive — one per representative model is enough to catch a
  // regression in the shared auto-CRUD middleware wiring.
  const guardedIndexes = [
    '/api/monitors',
    '/api/incidents',
    '/api/check-results',
    '/api/lighthouse-reports',
    '/api/webhook-subscriptions',
    '/api/status-pages',
    '/api/team-members',
    '/api/users',
  ]

  for (const path of guardedIndexes) {
    test(`unauthenticated GET ${path} is rejected with 401`, async () => {
      const res = await featureTest().get(path)
      // The Auth middleware runs before any DB access and 401s a request
      // with no bearer token / session cookie. A 200 here means the route
      // is anonymously browsable again — the exact regression we guard.
      expect(res.status).toBe(401)
    })
  }

  test('unauthenticated GET /api/monitors/{id} (show) is also rejected', async () => {
    const res = await featureTest().get('/api/monitors/1')
    expect(res.status).toBe(401)
  })
})
