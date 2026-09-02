/**
 * The health endpoint statushq monitors.
 *
 * The property under test is the one the old implementations got wrong: the
 * HTTP status has to follow the probes. bughq and analyticshq previously
 * answered a literal `{ status: 'ok' }` and loghq answered nothing at all, so a
 * monitor pointed at any of the three would have reported "up" through a total
 * database outage. A health check that cannot fail is worse than none — it
 * converts an unknown into a false assurance.
 *
 * The probe runner is injected rather than mocked at the module boundary so
 * these run with no database, no cache and no server.
 */
import type { ApplicationHealthResult } from '@stacksjs/router'
import { describe, expect, it } from 'bun:test'
import { APP, healthResponse } from '../../app/Support/health'

function report(status: 'healthy' | 'degraded', checks: ApplicationHealthResult['checks'] = {}): ApplicationHealthResult {
  return { status, checks, timestamp: 1_700_000_000_000 }
}

const healthy = () => Promise.resolve(report('healthy', {
  database: { ok: true, ms: 1 },
  cache: { ok: true, ms: 0 },
}))

const databaseDown = () => Promise.resolve(report('degraded', {
  database: { ok: false, ms: 1500, message: 'timeout' },
  cache: { ok: true, ms: 0 },
}))

describe('healthResponse', () => {
  it('answers 200 when every probe passes', async () => {
    const res = await healthResponse({ check: healthy })
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.status).toBe('healthy')
    expect(body.app).toBe(APP)
    expect(body.checks.database.ok).toBe(true)
  })

  it('answers 503 when a dependency is down', async () => {
    // The regression. The implementations this replaced returned 200 here.
    const res = await healthResponse({ check: databaseDown })
    expect(res.status).toBe(503)

    const body = await res.json()
    expect(body.status).toBe('degraded')
    expect(body.checks.database.ok).toBe(false)
  })

  it('answers 503, not 500, when the probe runner itself throws', async () => {
    const res = await healthResponse({
      check: () => Promise.reject(new Error('driver exploded')),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('degraded')
    // The reason survives into the body, so the monitor's captured response
    // says what broke instead of showing an opaque error page.
    expect(body.checks.probe.message).toBe('driver exploded')
  })

  it('names the app, so one monitor body identifies which app answered', async () => {
    const body = await (await healthResponse({ check: healthy })).json()
    expect(body.app).toBe(APP)
    expect(typeof body.app).toBe('string')
    expect(body.app.length).toBeGreaterThan(0)
  })

  it('forbids caching, so the monitor never reads a stale verdict', async () => {
    const res = await healthResponse({ check: healthy })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('merges app-specific facts without letting them decide the status', async () => {
    // An optional subsystem being unavailable is a degraded feature, not an
    // outage. It belongs in the body; it must not flip the status code.
    const res = await healthResponse({ check: healthy, extra: { geo: false } })
    expect(res.status).toBe(200)
    expect((await res.json()).geo).toBe(false)
  })
})
