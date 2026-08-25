#!/usr/bin/env bun
/**
 * End-to-end smoke test against a *running deployment* — by default the
 * production one. Everything else in tests/ talks to a local database through
 * the framework's own test harness, which means it verifies the code and not
 * the deployment: routing, the rpx gateway, the same-origin /api proxy, env
 * resolution and the systemd units are all mocked away. Every production
 * outage this project has had so far lived in exactly that gap (the /api 502
 * of 400ec72 passed every feature test in the suite), so this file speaks HTTP
 * to a real origin and asserts on what comes back.
 *
 *   bun scripts/e2e-smoke.ts                          # read-only, prod
 *   bun scripts/e2e-smoke.ts --base http://localhost:3000
 *   bun scripts/e2e-smoke.ts --journey                # + signed-in write path
 *
 * The default run performs NO writes: it reads public pages and pokes
 * unauthenticated endpoints that should refuse it. That half is safe to run
 * against production on a loop or from CI.
 *
 * --journey additionally registers a throwaway account and drives the real
 * product: create a monitor, run a check, publish a status page, read that
 * page back as an anonymous visitor, subscribe to it. It writes to whatever
 * database BASE points at, and cleans up the rows it can reach through the
 * API on the way out. Do not point it at production casually.
 */

const args = process.argv.slice(2)
const BASE = (readFlag('--base') ?? 'https://statushq.org').replace(/\/$/, '')
const JOURNEY = args.includes('--journey')
const VERBOSE = args.includes('--verbose')

function readFlag(name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

interface Failure {
  group: string
  name: string
  detail: string
}

const failures: Failure[] = []
let passed = 0
let group = 'general'

function setGroup(name: string): void {
  group = name
  console.log(`\n\x1B[1m${name}\x1B[0m`)
}

function ok(name: string, extra?: string): void {
  passed++
  console.log(`  \x1B[32m✓\x1B[0m ${name}${extra ? ` \x1B[2m${extra}\x1B[0m` : ''}`)
}

function fail(name: string, detail: string): void {
  failures.push({ group, name, detail })
  console.log(`  \x1B[31m✗\x1B[0m ${name}\n      \x1B[31m${detail}\x1B[0m`)
}

function check(name: string, condition: boolean, detail: string): boolean {
  if (condition) ok(name)
  else fail(name, detail)
  return condition
}

/**
 * One cookie jar for the whole run. `fetch` in Bun does not persist Set-Cookie
 * between calls, and the session here is a cookie (see Actions/Auth/authCookie),
 * so without this the journey would silently run every "signed in" step as an
 * anonymous visitor and pass on the 401 bodies.
 */
const jar = new Map<string, string>()

function jarHeader(): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorbCookies(res: Response): void {
  // getSetCookie() keeps multiple Set-Cookie headers separate; the plain
  // .get() joins them with commas and mangles Expires= dates.
  const raw = typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean)
  for (const line of raw as string[]) {
    const [pair] = line.split(';')
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim())
  }
}

interface Hit {
  status: number
  body: string
  headers: Headers
  ms: number
}

async function hit(path: string, init: RequestInit = {}): Promise<Hit> {
  const started = performance.now()
  const cookie = jarHeader()
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: {
      'user-agent': 'statushq-e2e-smoke',
      ...(cookie ? { cookie } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
  absorbCookies(res)
  const body = await res.text()
  const ms = Math.round(performance.now() - started)
  if (VERBOSE) console.log(`      \x1B[2m${init.method ?? 'GET'} ${path} -> ${res.status} (${ms}ms)\x1B[0m`)
  return { status: res.status, body, headers: res.headers, ms }
}

async function postJson(path: string, payload: unknown): Promise<Hit> {
  return hit(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Markers that mean a page rendered but rendered *wrong*. A 200 is a weak
 * assertion for a server-rendered template: an stx page whose <script server>
 * block throws still commonly returns 200 with the failure interpolated into
 * the HTML, which is precisely the failure mode a status-code-only smoke misses.
 */
const ROT = [
  'undefined',
  '[object Object]',
  'NaN',
  'Internal Server Error',
  'Cannot read properties',
  'SQLITE_',
  'at Object.<anonymous>',
]

function scanForRot(body: string): string[] {
  const found: string[] = []
  // Only look at rendered text, not inline scripts/styles — `undefined` and
  // `NaN` are legitimate tokens in JS, so scanning raw HTML flags every page
  // that ships a bundle.
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
  for (const marker of ROT) {
    if (text.includes(marker)) found.push(marker)
  }
  return found
}

async function publicPages(): Promise<void> {
  setGroup('Public pages render')

  const sitemap = await hit('/sitemap.xml')
  if (!check('sitemap.xml is served', sitemap.status === 200, `got ${sitemap.status}`))
    return

  const urls = [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]!)
  check('sitemap lists pages', urls.length > 0, 'no <loc> entries found')

  const wrongHost = urls.filter(u => !u.includes(new URL(BASE).host))
  if (BASE.includes('statushq.org')) {
    check(
      'every sitemap URL points at this host',
      wrongHost.length === 0,
      `${wrongHost.length} foreign URLs, e.g. ${wrongHost[0]}`,
    )
  }

  const paths = urls.map((u) => {
    try { return new URL(u).pathname }
    catch { return u }
  })

  // Crawl the sitemap rather than a hand-written list: a page that ships
  // without ever being smoke-tested is exactly the page that rots, and the
  // sitemap is already the canonical inventory of what we claim exists.
  let slowest = { path: '', ms: 0 }
  for (const path of paths) {
    const res = await hit(path)
    if (res.ms > slowest.ms) slowest = { path, ms: res.ms }

    if (res.status !== 200) {
      fail(`GET ${path}`, `expected 200, got ${res.status}`)
      continue
    }
    const rot = scanForRot(res.body)
    if (rot.length > 0) {
      fail(`GET ${path}`, `rendered but contains ${rot.join(', ')}`)
      continue
    }
    if (!/<title>[^<]+<\/title>/.test(res.body)) {
      fail(`GET ${path}`, 'no non-empty <title>')
      continue
    }
    if (!/<meta[^>]+name=["']description["'][^>]*>/i.test(res.body)) {
      fail(`GET ${path}`, 'no meta description')
      continue
    }
    ok(`GET ${path}`, `${res.ms}ms`)
  }

  console.log(`  \x1B[2mslowest: ${slowest.path} at ${slowest.ms}ms\x1B[0m`)
}

async function notFoundBehaviour(): Promise<void> {
  setGroup('Unknown routes 404 rather than 500')

  const cases: [string, string][] = [
    ['/this-page-does-not-exist-e2e', 'unknown marketing path'],
    ['/features/not-a-real-feature-e2e', 'unknown feature page'],
    ['/status/no-such-status-page-e2e', 'unknown status page slug'],
  ]

  for (const [path, label] of cases) {
    const res = await hit(path)
    check(
      `${label} -> 404`,
      res.status === 404,
      `expected 404, got ${res.status}${res.status >= 500 ? ` — ${res.body.slice(0, 200)}` : ''}`,
    )
  }
}

/**
 * The deploy failure this file exists for. /api/* is served by a separate
 * systemd unit behind a same-origin proxy, so it can be entirely down while
 * every marketing page is green — which is exactly what happened before
 * 400ec72. Any status other than a *gateway* error proves the proxy has a
 * live target; the endpoints are asked to refuse us, and a refusal is a
 * response.
 */
async function apiReachable(): Promise<void> {
  setGroup('API is reachable through the same-origin proxy')

  const res = await hit('/api/monitors')
  check(
    'GET /api/monitors reaches the API service',
    res.status !== 502 && res.status !== 503 && res.status !== 504,
    `gateway error ${res.status} — the /api proxy has no live target`,
  )
  check(
    'GET /api/monitors is JSON, not an HTML error page',
    (res.headers.get('content-type') ?? '').includes('json'),
    `content-type was ${res.headers.get('content-type')}`,
  )
}

async function authBoundary(): Promise<void> {
  setGroup('Unauthenticated callers are refused')

  // Every one of these is team-scoped data or a mutation. None may answer an
  // anonymous caller with a 2xx.
  const guarded: [string, string, unknown?][] = [
    ['GET', '/api/monitors'],
    ['GET', '/api/incidents'],
    ['POST', '/api/monitors', { name: 'e2e', url: 'https://example.com', type: 'uptime' }],
    ['POST', '/api/monitor-forms/create', { name: 'e2e', url: 'https://example.com', type: 'uptime' }],
    ['POST', '/api/status-page-forms/create', { title: 'e2e', slug: 'e2e-probe' }],
    ['POST', '/api/team-forms/switch', { team_id: 1 }],
    ['POST', '/api/security-forms/two-factor/disable', {}],
    // A maintenance window SILENCES alerting, so an unauthenticated caller
    // reaching this would be a way to stop someone else being paged.
    ['POST', '/api/maintenance-forms/create', { title: 'e2e', starts_at: '2030-01-01T00:00', ends_at: '2030-01-01T01:00' }],
  ]

  for (const [method, path, payload] of guarded) {
    const res = method === 'GET'
      ? await hit(path)
      : await postJson(path, payload ?? {})
    const refused = res.status === 401 || res.status === 403 || res.status === 419 || (res.status >= 300 && res.status < 400)
    check(
      `${method} ${path} refuses anonymous`,
      refused,
      `expected 401/403/redirect, got ${res.status} — ${res.body.slice(0, 160)}`,
    )
  }

  // Token-bearing public endpoints: the token IS the credential, so a bogus
  // one must be a clean 404 and never a 500 that leaks a stack trace.
  const bogus: [string, string][] = [
    ['/api/ping/e2e-definitely-not-a-real-token', 'heartbeat ping'],
    ['/api/regions/e2e-definitely-not-a-real-token/monitors', 'region agent poll'],
  ]
  for (const [path, label] of bogus) {
    const res = await hit(path)
    check(
      `${label} with a bogus token -> 4xx`,
      res.status >= 400 && res.status < 500,
      `expected 4xx, got ${res.status}`,
    )
  }

  const metrics = await postJson('/api/agent/e2e-definitely-not-a-real-token/metrics', {
    cpuPercent: 5, ramPercent: 5, ramUsedMb: 1, ramTotalMb: 2,
  })
  check(
    'agent metrics push with a bogus token -> 404',
    metrics.status === 404,
    `expected 404, got ${metrics.status} — ${metrics.body.slice(0, 160)}`,
  )

  // The marketing shell's session-aware CTA, guest half. The signed-in half
  // is asserted in journey(); both halves are needed, because the failure
  // that shipped for months was the control being a constant — and a
  // constant satisfies whichever half you check on its own.
  for (const path of ['/', '/features']) {
    const res = await hit(path)
    check(
      `${path} offers an anonymous visitor a way to sign in`,
      res.body.includes('href="/login"'),
      'no /login link in the rendered HTML',
    )
    check(
      `${path} does not offer a dashboard to an anonymous visitor`,
      !res.body.includes('href="/dashboard"'),
      'a /dashboard link rendered for a signed-out visitor',
    )
  }
}

/**
 * Dashboard routes are noindex and absent from the sitemap, so the crawl
 * above never touches them — yet a view that throws during SSR is exactly
 * the regression a deploy introduces. Signed out, each must render its own
 * "sign in required" state: a 404 means the route was never registered
 * (the failure mode that left maintenance windows unreachable for weeks),
 * and a 5xx means the server block threw before it could check auth.
 */
async function dashboardRoutesExist(): Promise<void> {
  setGroup('Dashboard routes are registered')

  const routes = [
    '/dashboard',
    '/dashboard/monitors',
    '/dashboard/monitors/new',
    '/dashboard/incidents',
    '/dashboard/status-pages',
    '/dashboard/maintenance',
  ]

  for (const path of routes) {
    const res = await hit(path)
    const reachable = res.status === 200 || (res.status >= 300 && res.status < 400)
    if (!reachable) {
      fail(`GET ${path}`, `expected 200 or a redirect, got ${res.status}`)
      continue
    }
    if (res.status === 200) {
      const rot = scanForRot(res.body)
      if (rot.length > 0) {
        fail(`GET ${path}`, `rendered but contains ${rot.join(', ')}`)
        continue
      }
    }
    ok(`GET ${path}`, `${res.status}`)
  }
}

async function transportSecurity(): Promise<void> {
  setGroup('Transport and headers')

  if (!BASE.startsWith('https://')) {
    console.log('  \x1B[2mskipped — target is not https\x1B[0m')
    return
  }

  const res = await hit('/')
  const hsts = res.headers.get('strict-transport-security')
  check('HSTS is set', !!hsts, 'no Strict-Transport-Security header')

  // The session cookie is the whole auth story here, so its flags matter more
  // than any other header on the response.
  const loginPage = await hit('/login')
  check('login page is served over https', loginPage.status === 200, `got ${loginPage.status}`)

  const httpBase = BASE.replace('https://', 'http://')
  const plain = await fetch(httpBase, { redirect: 'manual', signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (plain) {
    check(
      'plain http redirects to https',
      plain.status >= 300 && plain.status < 400 && (plain.headers.get('location') ?? '').startsWith('https://'),
      `got ${plain.status} -> ${plain.headers.get('location')}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Signed-in journey (--journey only)
// ---------------------------------------------------------------------------

async function journey(): Promise<void> {
  setGroup('Signed-in journey')

  const stamp = Date.now()
  const email = `e2e-smoke-${stamp}@statushq-e2e.invalid`
  const password = `e2e-${stamp}-pw`
  const slug = `e2e-smoke-${stamp}`

  const registered = await postJson('/api/register', {
    name: 'E2E Smoke',
    email,
    password,
  })
  if (!check('register a throwaway account', registered.status < 300, `got ${registered.status} — ${registered.body.slice(0, 240)}`))
    return

  check('registration set a session cookie', jar.size > 0, 'no Set-Cookie came back')

  const dashboard = await hit('/dashboard')
  check(
    'the new account can load /dashboard',
    dashboard.status === 200 && !dashboard.body.includes('need to sign in'),
    `got ${dashboard.status}; signed-out marker ${dashboard.body.includes('need to sign in')}`,
  )

  // The marketing shell's session-aware CTA, signed-in half — the guest
  // half is asserted in authBoundary(). Worth an assertion because the
  // marketing pages resolve the session from the auth cookie in a partial's
  // own server block, which is a different code path from anything the
  // dashboard exercises: a change that breaks it takes the whole public
  // site's signed-in state with it while every dashboard route stays green.
  for (const path of ['/', '/features']) {
    const res = await hit(path)
    check(
      `${path} offers a signed-in visitor their dashboard`,
      res.body.includes('href="/dashboard"'),
      'no /dashboard link in the rendered HTML',
    )
    check(
      `${path} stops asking a signed-in visitor to sign in`,
      !res.body.includes('href="/login"'),
      'a /login link still rendered for a signed-in visitor',
    )
  }

  const monitor = await postJson('/api/monitor-forms/create', {
    name: `E2E probe ${stamp}`,
    url: 'https://example.com',
    type: 'uptime',
    enabled: true,
    check_interval_seconds: 300,
  })
  const monitorOk = check('create a monitor', monitor.status < 300, `got ${monitor.status} — ${monitor.body.slice(0, 240)}`)

  let monitorId: number | undefined
  if (monitorOk) {
    const parsed = safeJson(monitor.body)
    monitorId = parsed?.id ?? parsed?.monitor?.id ?? parsed?.data?.id
    check('the created monitor came back with an id', typeof monitorId === 'number', `body was ${monitor.body.slice(0, 240)}`)
  }

  if (typeof monitorId === 'number') {
    const ran = await postJson(`/api/monitors/${monitorId}/check`, {})
    check('run an out-of-band check on it', ran.status < 300, `got ${ran.status} — ${ran.body.slice(0, 240)}`)
  }

  const page = await postJson('/api/status-page-forms/create', {
    title: `E2E Smoke ${stamp}`,
    slug,
  })
  const pageOk = check('publish a status page', page.status < 300, `got ${page.status} — ${page.body.slice(0, 240)}`)

  if (pageOk) {
    // Read it back with no credentials at all — a status page that only works
    // for its owner is the failure this whole feature exists to avoid.
    const saved = new Map(jar)
    jar.clear()
    const publicView = await hit(`/status/${slug}`)
    check(
      'an anonymous visitor can read the status page',
      publicView.status === 200,
      `got ${publicView.status}`,
    )
    check(
      'the public page shows the page title',
      publicView.body.includes(`E2E Smoke ${stamp}`),
      'title not found in the rendered HTML',
    )
    const feed = await hit(`/api/status/${slug}/feed`)
    check('its incident feed is public', feed.status === 200, `got ${feed.status}`)
    for (const [k, v] of saved) jar.set(k, v)
  }

  // Cleanup. Best-effort: report what could not be removed rather than
  // failing the run, so a cleanup gap never masks a green product path.
  setGroup('Journey cleanup')
  if (typeof monitorId === 'number') {
    const deleted = await postJson(`/api/monitor-forms/${monitorId}/delete`, {})
    check('the e2e monitor was deleted', deleted.status < 300, `got ${deleted.status}; monitor ${monitorId} may need manual removal`)
  }
  console.log(`  \x1B[2mleft behind: account ${email}, status page /status/${slug}\x1B[0m`)

  const loggedOut = await postJson('/api/logout', {})
  check('logout succeeds', loggedOut.status < 400, `got ${loggedOut.status}`)
}

function safeJson(body: string): any {
  try { return JSON.parse(body) }
  catch { return null }
}

// ---------------------------------------------------------------------------

console.log(`\x1B[1mE2E smoke\x1B[0m against \x1B[36m${BASE}\x1B[0m${JOURNEY ? ' \x1B[33m(+ write journey)\x1B[0m' : ' \x1B[2m(read-only)\x1B[0m'}`)

await publicPages()
await notFoundBehaviour()
await apiReachable()
await authBoundary()
await dashboardRoutesExist()
await transportSecurity()
if (JOURNEY) await journey()

console.log(`\n\x1B[1mResult\x1B[0m  \x1B[32m${passed} passed\x1B[0m, ${failures.length > 0 ? `\x1B[31m${failures.length} failed\x1B[0m` : '0 failed'}`)
if (failures.length > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  \x1B[31m${f.group} › ${f.name}\x1B[0m\n    ${f.detail}`)
  process.exit(1)
}
