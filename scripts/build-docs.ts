#!/usr/bin/env bun
/**
 * Builds the bunpress documentation, then injects the marketing footer into
 * every generated page. bunpress's layouts have no footer slot, so the footer
 * is stitched in here (post-build) rather than via config. Runs as the
 * `docs:build` script — locally and in the deploy's preStart (config/cloud.ts).
 *
 * Links are absolute (uptime-status.org / github / bsky) so they resolve across
 * the /docs ↔ marketing-site boundary and aren't rewritten by bunpress's base
 * prefixer or intercepted by its SPA router.
 */
import { Glob } from 'bun'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const OUT = 'dist/docs/.bunpress'
const SITE = 'https://uptime-status.org'
const GH = 'https://github.com/stacksjs/status'

const GITHUB_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.1.82-.26.82-.58v-2.02c-3.34.73-4.04-1.6-4.04-1.6-.55-1.4-1.34-1.76-1.34-1.76-1.1-.75.08-.74.08-.74 1.2.09 1.84 1.24 1.84 1.24 1.08 1.84 2.81 1.3 3.5 1 .1-.78.42-1.3.76-1.6-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .3Z"/></svg>'
const BLUESKY_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.789.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"/></svg>'
const WORDMARK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M2.5 12h3.5l2-5 3 10 2-7 1.5 3.5h6.5"/></svg>'

// Brand mark for the top-nav title (bunpress renders the title as plain text).
const NAVMARK = `<span class="dx-navmark">${WORDMARK_SVG}</span>`

const li = (href: string, text: string) => `<li><a href="${href}">${text}</a></li>`

const FOOTER = `
<footer class="dx-footer">
  <div class="dx-footer-inner">
    <div class="dx-footer-grid">
      <div class="dx-footer-brand">
        <a class="dx-brand" href="${SITE}/" aria-label="UptimeStatus home">
          <span class="dx-brand-mark">${WORDMARK_SVG}</span>
          <span class="dx-brand-name">UptimeStatus</span>
        </a>
        <p>Open-source uptime, SSL, DNS, and status-page monitoring. Self-hosted, or fully managed by us.</p>
      </div>
      <div class="dx-footer-col">
        <h4>Monitoring</h4>
        <ul>
          ${li(`${SITE}/features/uptime-monitoring`, 'Uptime')}
          ${li(`${SITE}/features/ssl-monitoring`, 'SSL certificates')}
          ${li(`${SITE}/features/dns-monitoring`, 'DNS')}
          ${li(`${SITE}/features/domain-monitoring`, 'Domains')}
          ${li(`${SITE}/features/broken-links`, 'Broken links')}
          ${li(`${SITE}/features/cron-monitoring`, 'Cron &amp; heartbeats')}
          ${li(`${SITE}/features/performance-monitoring`, 'Performance')}
          ${li(`${SITE}/features`, 'All features')}
        </ul>
      </div>
      <div class="dx-footer-col">
        <h4>Documentation</h4>
        <ul>
          ${li(`${SITE}/docs/introduction`, 'Introduction')}
          ${li(`${SITE}/docs/getting-started`, 'Quick start')}
          ${li(`${SITE}/docs/monitors/`, 'Monitors')}
          ${li(`${SITE}/docs/operate/notifications`, 'Notifications')}
          ${li(`${SITE}/docs/self-hosting/deploy`, 'Self-hosting')}
          ${li(`${SITE}/docs/reference/api`, 'API')}
        </ul>
      </div>
      <div class="dx-footer-col">
        <h4>Use cases</h4>
        <ul>
          ${li(`${SITE}/for/agencies`, 'Agencies')}
          ${li(`${SITE}/for/saas`, 'SaaS teams')}
          ${li(`${SITE}/for/ecommerce`, 'E-commerce')}
          ${li(`${SITE}/for/devops`, 'DevOps &amp; SRE')}
          ${li(`${SITE}/compare`, 'Compare')}
        </ul>
      </div>
      <div class="dx-footer-col">
        <h4>Resources</h4>
        <ul>
          ${li(`${SITE}/docs`, 'Docs')}
          ${li(GH, 'GitHub')}
          ${li(`${GH}/blob/main/LICENSE.md`, 'License')}
          ${li(`${SITE}/login`, 'Sign in')}
          ${li(`${SITE}/register`, 'Get started')}
        </ul>
      </div>
    </div>
    <div class="dx-footer-bottom">
      <span>&copy; 2026 UptimeStatus. MIT licensed.</span>
      <span class="dx-footer-social">
        <a href="${GH}" target="_blank" rel="noopener" aria-label="UptimeStatus on GitHub">${GITHUB_SVG}</a>
        <a href="https://bsky.app/profile/uptime-status.org" target="_blank" rel="noopener" aria-label="UptimeStatus on Bluesky">${BLUESKY_SVG}</a>
      </span>
    </div>
  </div>
</footer>
`.trim()

// 1) Build the docs with bunpress.
const build = Bun.spawnSync(
  ['bun', 'node_modules/@stacksjs/bunpress/dist/bin/cli.js', 'build', '--dir', './docs', '--outdir', './dist/docs'],
  { stdout: 'inherit', stderr: 'inherit' },
)
if (build.exitCode !== 0) {
  console.error('bunpress build failed')
  process.exit(build.exitCode ?? 1)
}

// 2) Inject the footer into every built page (idempotent).
if (!existsSync(OUT)) {
  console.error(`docs output not found at ${OUT}`)
  process.exit(1)
}
// Only the sidebar-less pages (the home / plain pages) get the full marketing
// footer — on doc pages the fixed left sidebar and right TOC would overlay a
// bottom footer, and a big marketing footer under every reference page is
// unusual anyway. `class="BPSidebar"` marks a doc-layout page.
let footers = 0
let logos = 0
for (const rel of new Glob('**/*.html').scanSync({ cwd: OUT })) {
  const file = path.join(OUT, rel)
  let html = await Bun.file(file).text()
  let changed = false

  // Brand mark in the top-nav title — on every page (the nav is everywhere).
  if (!html.includes('class="dx-navmark"') && html.includes('class="BPNavBarTitle">')) {
    html = html.replace('class="BPNavBarTitle">', `class="BPNavBarTitle">${NAVMARK}`)
    logos++
    changed = true
  }

  // Marketing footer — only on sidebar-less pages (the home): a doc page's
  // fixed left sidebar + right TOC would overlay a bottom footer.
  if (!html.includes('class="dx-footer"') && html.includes('</body>') && !html.includes('class="BPSidebar"')) {
    html = html.replace('</body>', `${FOOTER}\n</body>`)
    footers++
    changed = true
  }

  if (changed)
    await Bun.write(file, html)
}
console.log(`✓ injected nav brand mark into ${logos} page(s); marketing footer into ${footers} page(s)`)
