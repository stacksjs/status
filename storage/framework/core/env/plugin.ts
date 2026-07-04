/**
 * Bun plugin entry point for automatic .env loading
 * This file can be imported in bunfig.toml preload or used programmatically
 */

import { autoLoadEnv } from './src/plugin'

// Auto-load .env files when this module is imported
//
// keysFile MUST be passed here: autoLoadEnv only resolves a decryption
// private key from a keys FILE when explicitly told which one to read —
// without it, an encrypted .env.production (DOTENV_PUBLIC_KEY_PRODUCTION
// + `encrypted:...` values) loads with every encrypted value left as raw
// ciphertext in process.env. Because this plugin is the FIRST bunfig.toml
// preload (before the app's main preloader), that raw ciphertext gets set
// into process.env first — and since loadEnv() only fills in keys that
// aren't already set, the app preloader's later, correctly-decrypted
// re-load of the same key is silently ignored. See the matching fix +
// comment in storage/framework/defaults/resources/plugins/preloader.ts.
const result = autoLoadEnv({ quiet: false, keysFile: '.env.keys' })

if (result.errors.length > 0) {
  console.error('[env-plugin] Errors:', result.errors)
}

// Export for programmatic usage
export { autoLoadEnv, envPlugin, loadEnv } from './src/plugin'
export * from './src/crypto'
export * from './src/parser'
export * from './src/cli'
