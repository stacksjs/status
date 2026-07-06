/**
 * Test Setup
 *
 * Runs before every test file. Sets environment variables that must
 * be present before any @stacksjs/* packages are evaluated, then
 * initialises the test environment.
 */

import { generateKeyPairSync } from 'node:crypto'
import { setupTestEnvironment } from '@stacksjs/testing'

// Env vars that config reads at module-evaluation time
if (!Bun.env.STRIPE_SECRET_KEY)
  Bun.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_testing'

// Fake social-login credentials so config/sso.ts + config/services.ts
// enable the google/apple/github providers under test — see
// tests/feature/sso-social-login.test.ts, which mocks the provider HTTP
// endpoints themselves. Guarded so real env always wins.
if (!Bun.env.GITHUB_CLIENT_ID) {
  Bun.env.GITHUB_CLIENT_ID = 'test-github-id'
  Bun.env.GITHUB_CLIENT_SECRET = 'test-github-secret'
}
if (!Bun.env.GOOGLE_CLIENT_ID) {
  Bun.env.GOOGLE_CLIENT_ID = 'test-google-id'
  Bun.env.GOOGLE_CLIENT_SECRET = 'test-google-secret'
}
if (!Bun.env.APPLE_CLIENT_ID) {
  Bun.env.APPLE_CLIENT_ID = 'org.uptime-status.test'
  Bun.env.APPLE_TEAM_ID = 'TESTTEAM01'
  Bun.env.APPLE_KEY_ID = 'TESTKEY001'
  // The Apple driver signs a real ES256 JWT, so the key must parse.
  Bun.env.APPLE_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
}

setupTestEnvironment()
