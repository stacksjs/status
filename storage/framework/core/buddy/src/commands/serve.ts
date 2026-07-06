import type { CLI } from '@stacksjs/types'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import process from 'node:process'
import { log } from '@stacksjs/cli'

/**
 * Request-scoped context (query string + parsed cookies) for `<script
 * server>` blocks in `.stx` pages — mirrors `dev/views.ts`'s dev-only
 * setup of the same globals. Without this, `globalThis.requestContext`
 * and `__stxServeSearch` are simply undefined in production: every
 * cookie-aware or query-param-aware page (auth+team resolution on the
 * dashboard, filter params on monitors/incidents, etc.) silently reads
 * nothing and falls back to its unauthenticated/no-filter state, even
 * for a legitimately signed-in request. `dev/views.ts` sets these up
 * for `buddy dev`, but `buddy serve` (this file, the actual Hetzner
 * entrypoint) never did — this was found by an end-to-end login +
 * dashboard smoke test, not by inspection.
 *
 * Plain globals, not `AsyncLocalStorage` — tried that first (mirroring
 * dev/views.ts's own approach) and confirmed via the same e2e test that
 * the store is empty by the time a `<script server>` block reads it:
 * bun-plugin-stx's internal request handling doesn't preserve the async
 * context across whatever it does between `onRequest` returning and the
 * page actually rendering. `__stxServeSearch` already uses a plain
 * global for the exact same reason (and already accepts the same
 * concurrent-request race this shares) — `__stxServeCookies` follows
 * that precedent instead of a mechanism that demonstrably doesn't work
 * in this server.
 */
;(globalThis as any).requestContext = {
  cookie(name: string): string | null {
    const cookies = (globalThis as { __stxServeCookies?: Record<string, string> }).__stxServeCookies
    return cookies?.[name] ?? null
  },
  url(): string {
    return (globalThis as { __stxServeSearch?: string }).__stxServeSearch ?? ''
  },
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {}
  const header = req.headers.get('cookie') || ''
  if (!header)
    return out
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq === -1)
      continue
    const k = trimmed.slice(0, eq).trim()
    const v = trimmed.slice(eq + 1).trim()
    if (!k)
      continue
    try { out[k] = decodeURIComponent(v) }
    catch { out[k] = v }
  }
  return out
}

/**
 * `buddy serve` — boot the production HTTP server.
 *
 * Renders the project's STX views (resources/views) via stx-serve and applies
 * the maintenance / coming-soon gate so `APP_COMING_SOON` (and `buddy down` /
 * `buddy coming-soon`) hold every request behind the holding page, with the
 * secret-URL + bypass-cookie escape hatch intact. Bun.serve binds 0.0.0.0 by
 * default, so the server is reachable on the host's public interface.
 *
 * Same-origin `/api/**` requests (and any non-GET/HEAD verb) are
 * reverse-proxied to the API process — mirroring the dev views server — so
 * scaffolded `fetch('/api/...')` calls behave identically in production
 * (stacksjs/stacks#1950). The API runs as a separate process
 * (core/actions/src/serve/api.ts), deployed as a second systemd service via
 * the `api` site in config/cloud.ts. Override `API_URL` when the API lives
 * on another host, or `PORT_API` when only the port differs.
 *
 * This is the entry the Hetzner deploy runs as a systemd service
 * (`bun storage/framework/core/buddy/src/cli.ts serve`).
 */
export function serve(buddy: CLI): void {
  buddy
    .command('serve', 'Start the production HTTP server (STX views + /api proxy + coming-soon/maintenance gate)')
    .option('-p, --port <port>', 'Port to listen on (defaults to PORT env or 3000)')
    .option('--verbose', 'Enable verbose output', { default: false })
    .action(async (options?: { port?: string | number, verbose?: boolean }) => {
      if (options?.port)
        process.env.PORT = String(options.port)
      process.env.APP_ENV = process.env.APP_ENV || 'production'

      const port = Number(process.env.PORT) || 3000

      const { config, overridesReady } = await import('@stacksjs/config')
      await overridesReady

      const { injectGlobalAutoImports } = await import('@stacksjs/server')
      await injectGlobalAutoImports()

      // Resolve the stx `serve` implementation: local STX worktree first
      // (dev machines), then the project's pantry-vendored copy, then the
      // installed npm package.
      let stxServe: any
      const serveCandidates = [
        join(homedir(), 'Code/Tools/stx/packages/bun-plugin/dist/serve.js'),
        join(process.cwd(), 'pantry/bun-plugin-stx/dist/serve.js'),
      ]
      for (const entry of serveCandidates) {
        try {
          if (existsSync(entry)) {
            ;({ serve: stxServe } = await import(entry))
            break
          }
        }
        catch { /* try next */ }
      }
      if (!stxServe)
        ;({ serve: stxServe } = await import('bun-plugin-stx/serve'))

      // Pre-resolve the vendored stx module + site/i18n config so `{t:…}`
      // translation tokens and the lang picker render in production exactly
      // like they do under `buddy dev`.
      const stxModule = await resolveVendoredStxModule()
      const { site: siteConfig, i18n: i18nConfig } = await loadStxSiteConfig()

      const userViewsPath = 'resources/views'
      const defaultViewsPath = 'storage/framework/defaults/resources/views'
      const userLayoutsPath = existsSync('resources/views/layouts') ? 'resources/views/layouts' : 'resources/layouts'
      const userComponentsPath = existsSync('resources/views/components') ? 'resources/views/components' : 'resources/components'

      // Same-origin API target. Scaffolded client code fetches relative
      // `/api/...` URLs (dashboard stores, CartDrawer, the coming-soon
      // subscribe form), which the dev server reverse-proxies to the API
      // process — production must do the same or every login and form
      // POST 404s on stx-serve (stacksjs/stacks#1950).
      const apiBase = process.env.API_URL
        || `http://127.0.0.1:${Number(process.env.PORT_API) || config.ports?.api || 3008}`

      log.info(`Starting production server on port ${port}...`)

      await stxServe({
        patterns: [userViewsPath, defaultViewsPath],
        port,
        // Never silently drift off the configured port: the reverse
        // proxy/gateway routes to exactly this port, so stx's fallback bind
        // on port+1 would serve nothing. Fail loudly instead (systemd
        // restarts / the deploy health gate catches it).
        autoIncrementPort: false,
        // SO_REUSEPORT (stx >= 0.2.81): lets the next release's instance
        // bind the same port while this one still serves — the overlap
        // ts-cloud's zero-downtime cutover needs. Production only: in local
        // runs two servers fighting over one port should fail loudly.
        // Ignored harmlessly by older stx versions.
        reusePort: (process.env.APP_ENV || '').toLowerCase() === 'production',
        componentsDir: 'storage/framework/defaults/resources/components',
        layoutsDir: userLayoutsPath,
        partialsDir: userComponentsPath,
        fallbackLayoutsDir: 'storage/framework/defaults/resources/layouts',
        fallbackPartialsDir: defaultViewsPath,
        quiet: options?.verbose !== true,
        ...(stxModule && { stxModule }),
        ...(i18nConfig && { i18n: i18nConfig }),
        ...(siteConfig?.url && { site: siteConfig }),
        // Maintenance / coming-soon gate runs first so it intercepts every
        // request. The gate allowlists `/coming-soon`, the secret bypass URL,
        // and static assets, so the holding page renders and visitors with a
        // valid bypass cookie pass through.
        onRequest: async (req: Request) => {
          const { maintenanceGate, isApiBoundRequest, proxyToBackend } = await import('@stacksjs/server')
          const gated = await maintenanceGate(req)
          if (gated)
            return gated

          // Mirror the dev server's API forwarding: `/api/**` and any
          // non-GET/HEAD verb belong to bun-router, never stx-serve.
          const url = new URL(req.url)
          if (isApiBoundRequest(req, url.pathname)) {
            try {
              return await proxyToBackend(req, apiBase)
            }
            catch (error) {
              log.error(`API proxy to ${apiBase} failed: ${(error as Error).message}`)
              return new Response('Bad Gateway', { status: 502 })
            }
          }

          // Serve the bunpress documentation under /docs from the static build
          // (dist/docs/.bunpress, produced by `buddy docs:build` in the deploy's
          // preStart). Handled in-process — same origin as the app, no separate
          // gateway route — with VitePress-style extensionless URL resolution.
          // Returns undefined when the build is absent, so the request falls
          // through to the stx /docs landing page as a graceful fallback.
          if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) {
            const docsResponse = serveDocsStatic(url.pathname)
            if (docsResponse)
              return docsResponse
          }

          // Stash cookies + query string so server-script blocks rendering
          // this request can pull them via globalThis.requestContext /
          // __stxServeSearch — see the doc comment above this function.
          ;(globalThis as { __stxServeSearch?: string }).__stxServeSearch = url.search
          ;(globalThis as { __stxServeCookies?: Record<string, string> }).__stxServeCookies = parseCookies(req)

          return undefined
        },
      })

      log.success(`Production server listening on http://0.0.0.0:${port}`)
    })
}

const DOCS_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serve a request under `/docs` from the built bunpress site at
 * `dist/docs/.bunpress`. bunpress emits clean, extensionless URLs
 * (`/docs/monitors/uptime`), so this maps a pathname to `monitors/uptime.html`,
 * `/docs` (or `/docs/`) to `index.html`, and passes real asset files through
 * by exact match. Returns `undefined` when the build directory is missing so
 * the caller falls through to the stx `/docs` landing page.
 */
function serveDocsStatic(pathname: string): Response | undefined {
  const DOCS_ROOT = join(process.cwd(), 'dist/docs/.bunpress')
  if (!existsSync(DOCS_ROOT))
    return undefined

  let rel = decodeURIComponent(pathname).replace(/^\/docs/, '')
  if (rel.includes('..')) // defend against path traversal
    return new Response('Bad Request', { status: 400 })

  const candidates: string[] = []
  if (rel === '' || rel === '/') {
    candidates.push(join(DOCS_ROOT, 'index.html'))
  }
  else {
    rel = rel.replace(/\/+$/, '')
    candidates.push(join(DOCS_ROOT, rel)) // exact file (assets, images, …)
    if (!extname(rel)) {
      candidates.push(join(DOCS_ROOT, `${rel}.html`)) // extensionless page
      candidates.push(join(DOCS_ROOT, rel, 'index.html')) // directory index
    }
  }

  for (const file of candidates) {
    if (existsSync(file) && statSync(file).isFile()) {
      return new Response(Bun.file(file), {
        headers: { 'content-type': DOCS_MIME[extname(file)] || 'application/octet-stream' },
      })
    }
  }

  // Under /docs but nothing matched — serve the docs' own 404 so the user stays
  // in the documentation shell rather than hitting the app's 404.
  const notFound = join(DOCS_ROOT, '404.html')
  if (existsSync(notFound)) {
    return new Response(Bun.file(notFound), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }
  return new Response('Not Found', { status: 404 })
}

async function resolveVendoredStxModule(): Promise<any | undefined> {
  const candidates = [
    join(homedir(), 'Code/Tools/stx/packages/stx/dist/index.js'),
    join(process.cwd(), 'pantry/@stacksjs/stx/dist/index.js'),
  ]
  for (const entry of candidates) {
    try {
      if (existsSync(entry))
        return await import(entry)
    }
    catch { /* try next */ }
  }
  // Production fallback: the installed npm package (resolved from node_modules).
  // On a deployed server there is no dev worktree or `pantry/` dir — deps are
  // installed via `bun install`, so this is the path that actually resolves.
  try {
    return await import('@stacksjs/stx')
  }
  catch { /* not installed */ }
  return undefined
}

function fallbackI18nFromSite(site: any) {
  const locales: string[] = site.i18n.locales
  const defaultLocale = site.i18n.defaultLocale ?? locales[0]
  return {
    locales,
    defaultLocale,
    labels: site.i18n.labels ?? Object.fromEntries(locales.map(c => [c, c.toUpperCase()])),
    translations: {} as Record<string, Record<string, string>>,
    pickerSelector: site.i18n.pickerSelector ?? '#lang-picker',
  }
}

async function resolveSiteI18n(site: any): Promise<any> {
  const resolverPaths = [
    join(homedir(), 'Code/Tools/stx/packages/stx/src/site-builder/i18n.ts'),
    join(homedir(), 'Code/Tools/stx/packages/stx/dist/index.js'),
    join(process.cwd(), 'pantry/@stacksjs/stx/dist/index.js'),
  ]
  for (const resolverPath of resolverPaths) {
    try {
      if (!existsSync(resolverPath))
        continue
      const resolved = await import(resolverPath)
      if (typeof resolved.resolveI18n !== 'function')
        continue
      const i18n = resolved.resolveI18n(site, process.cwd())
      if (i18n)
        return i18n
    }
    catch { /* try next */ }
  }
  // Production fallback: resolve `resolveI18n` from the installed npm package so
  // `{t:…}` tokens render on a deployed server (no dev worktree / pantry dir).
  try {
    const resolved = await import('@stacksjs/stx')
    if (typeof (resolved as any).resolveI18n === 'function') {
      const i18n = (resolved as any).resolveI18n(site, process.cwd())
      if (i18n)
        return i18n
    }
  }
  catch { /* not installed */ }
  return fallbackI18nFromSite(site)
}

async function loadStxSiteConfig(): Promise<{ site?: any, i18n?: any }> {
  const sitePath = join(process.cwd(), 'site.config.ts')
  if (!existsSync(sitePath))
    return {}

  try {
    const mod = await import(sitePath)
    const site = mod.default
    if (!site)
      return {}
    if (!site.i18n)
      return { site }
    const i18n = await resolveSiteI18n(site)
    return { site, i18n }
  }
  catch { /* no site config */ }

  return {}
}
