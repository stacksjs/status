import { autoLoadEnv } from '@stacksjs/env'

// App-level replacement for the vendored storage/framework/core/env/plugin.ts.
// The published @stacksjs/env exports autoLoadEnv but never invokes it, so the
// side-effecting call that a bunfig preload depends on has to live in the app.
//
// keysFile is passed explicitly to match the vendored shim. As of 0.72.x it is
// also the upstream default, and the loader now warns on skipped encrypted
// values rather than leaving ciphertext in process.env silently.
const result = autoLoadEnv({ quiet: false, keysFile: '.env.keys' })

if (result.errors.length > 0)
  console.error('[env-plugin] Errors:', result.errors)
