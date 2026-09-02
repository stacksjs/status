import type { ApplicationHealthResult } from '@stacksjs/router'
import { checkApplicationHealth } from '@stacksjs/router'

/** The name this app answers to in its own health body. */
export const APP = 'statushq'

export interface HealthOptions {
  /**
   * The probe runner. Defaults to the framework's, which checks the database
   * (`SELECT 1`) and the cache (set, then delete) with a 1.5s timeout each.
   * Injectable so the failure path can be tested without taking a real
   * dependency down.
   */
  check?: () => Promise<ApplicationHealthResult>
  /** App-specific facts merged into the body. */
  extra?: Record<string, unknown>
}

/**
 * The health endpoint an uptime monitor can actually trust.
 *
 * ## Why this is registered by hand
 *
 * The framework already ships exactly this — `route.health()`, in
 * `storage/framework/defaults/routes/dashboard.ts` — but reaching it depends on
 * two conditions that have nothing to do with health, and every app in this
 * fleet failed one of them:
 *
 *   - `config/dashboard.ts` → `enabled`. Turning off the admin UI also removes
 *     `/api/health`. loghq has the dashboard off, so it answered 404.
 *   - the vendored `storage/framework/` tree reaching the box. Apps that
 *     gitignore it (loghq, bughq, analyticshq) never ship those default routes,
 *     so the call site is simply absent in production. Verified on the box:
 *     `storage/framework/defaults/routes/` is present for statushq and absent
 *     for bughq, on the same machine.
 *
 * Registering it here makes the endpoint a property of this app rather than of
 * a UI flag and a build artifact. User routes load before the framework's, so
 * this also wins wherever the default one is present.
 *
 * ## Why not a static 200
 *
 * bughq and analyticshq previously answered `{ status: 'ok' }` from a literal.
 * That endpoint cannot fail: it returns 200 with the database down, the cache
 * gone, and every page 500ing. Pointing a monitor at it would have produced a
 * green dashboard straight through an outage — worse than having no monitor at
 * all, because one is a known gap and the other is a false assurance.
 *
 * Answering 503 on a failed probe is what makes this readable by a plain HTTP
 * check, so no monitor has to understand the body to get the right answer.
 */
export async function healthResponse(options: HealthOptions = {}): Promise<Response> {
  const check = options.check ?? checkApplicationHealth

  let health: ApplicationHealthResult
  try {
    health = await check()
  }
  catch (err) {
    // A probe runner that throws is itself a failure, and reporting it as one
    // beats a 500 from an unhandled rejection: the monitor gets a body it can
    // read rather than an opaque error page.
    health = {
      status: 'degraded',
      checks: { probe: { ok: false, ms: 0, message: err instanceof Error ? err.message : String(err) } },
      timestamp: Date.now(),
    }
  }

  return new Response(JSON.stringify({ app: APP, ...health, ...(options.extra ?? {}) }), {
    status: health.status === 'healthy' ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      // A cached health check reports the past. Nothing between us and the
      // monitor may answer this from a store.
      'Cache-Control': 'no-store',
    },
  })
}
