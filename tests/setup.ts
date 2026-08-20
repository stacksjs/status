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

// SSO signs its flow cookie with an HMAC keyed on APP_KEY and throws without
// one (app/Actions/Auth/oidc.ts hmacKey). A developer machine has APP_KEY in
// .env, but .env is gitignored, so CI had none and every SSO test 500'd while
// passing locally. Fixed rather than random: the tests assert on signatures,
// so the key has to be stable within a run, and a real secret must never be
// needed to run the suite. Guarded so a real env always wins.
if (!Bun.env.APP_KEY)
  Bun.env.APP_KEY = 'base64:dGVzdC1vbmx5LWFwcC1rZXktZm9yLXRoZS1zdWl0ZQ=='

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
  Bun.env.APPLE_CLIENT_ID = 'org.statushq.test'
  Bun.env.APPLE_TEAM_ID = 'TESTTEAM01'
  Bun.env.APPLE_KEY_ID = 'TESTKEY001'
  // The Apple driver signs a real ES256 JWT, so the key must parse.
  Bun.env.APPLE_PRIVATE_KEY = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString()
}

setupTestEnvironment()
