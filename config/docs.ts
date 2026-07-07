import type { BunPressOptions } from '@stacksjs/bunpress'

/**
 * UptimeStatus documentation (bunpress).
 *
 * Built to `dist/docs/.bunpress` and served at https://uptime-status.org/docs
 * — `sitemap.baseUrl`'s `/docs` pathname is what tells bunpress to emit every
 * internal link under `/docs`, so the built site mounts cleanly at that path
 * behind the production rpx gateway (see the `docs` static site in
 * config/cloud.ts). Theme mirrors the marketing site's design tokens (Space
 * Grotesk display, Inter body, blue accent, light + dark) so the docs read as
 * the same product as uptime-status.org.
 */
const config: BunPressOptions = {
  verbose: false,
  docsDir: './docs',
  outDir: './dist/docs',

  // Load the marketing site's typefaces (bunpress emits the Google Fonts
  // <link> tags into every page head); referenced from `markdown.css` below.
  fonts: {
    google: [
      'Space Grotesk:wght@500;600;700',
      'Inter:wght@400;500;600;700',
      'JetBrains Mono:wght@400;600',
    ],
  },

  // Top navigation
  nav: [
    { text: 'Guide', link: '/introduction' },
    { text: 'Monitors', link: '/monitors/' },
    { text: 'Self-hosting', link: '/self-hosting/deploy' },
    { text: 'Dashboard', link: 'https://uptime-status.org/dashboard' },
    { text: 'GitHub', link: 'https://github.com/stacksjs/status' },
  ],

  // Markdown configuration
  markdown: {
    title: 'UptimeStatus Docs',
    meta: {
      description: 'Documentation for UptimeStatus — open-source uptime, SSL, DNS, and status-page monitoring. Self-hosted, or fully managed.',
      author: 'UptimeStatus',
    },
    syntaxHighlightTheme: 'github-dark',
    toc: {
      enabled: true,
      minDepth: 2,
      maxDepth: 3,
    },

    // Brand the theme to match uptime-status.org. bunpress folds `markdown.css`
    // into every page's stylesheet additively (after the theme CSS), so this
    // repoints the theme's brand color (default indigo) to the marketing blue
    // and pins the display/body/mono typefaces loaded via top-level `fonts`.
    css: `
:root {
  --bp-c-brand-1: #2563eb;
  --bp-c-brand-2: #3b82f6;
  --bp-c-brand-3: #60a5fa;
  --bp-c-brand-soft: rgba(37, 99, 235, 0.14);
}
.dark {
  --bp-c-brand-1: #60a5fa;
  --bp-c-brand-2: #3b82f6;
  --bp-c-brand-3: #2563eb;
  --bp-c-brand-soft: rgba(96, 165, 250, 0.16);
}
h1, h2, h3, h4, h5, h6,
.hero-container .name, .hero-container .text {
  font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.01em;
}
body { font-family: "Inter", ui-sans-serif, system-ui, sans-serif; }
code, pre, kbd, tt { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; }

/* Custom home landing — marketing-style sectioned card grids, matching
   uptime-status.org (hero stays the bunpress home hero above these). */
.dx-section { max-width: 1152px; margin: 0 auto; padding: clamp(2.5rem, 6vw, 4rem) 24px 0; }
.dx-section:last-of-type { padding-bottom: 2.5rem; }
.dx-head { max-width: 44rem; margin: 0 0 1.75rem; }
.dx-eyebrow { display: block; margin-bottom: 0.6rem; color: var(--bp-c-brand-1); font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.dx-title { margin: 0 0 0.5rem; font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-size: clamp(1.55rem, 3vw, 2.05rem); font-weight: 600; letter-spacing: -0.015em; line-height: 1.15; }
.dx-lead { margin: 0; color: var(--bp-c-text-2); font-size: 1.05rem; line-height: 1.6; }
.dx-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
a.dx-card { display: block; position: relative; padding: 1.5rem; border: 1px solid var(--bp-c-divider); border-radius: 14px; background: var(--bp-c-bg-soft); color: var(--bp-c-text-1); text-decoration: none !important; transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease; }
a.dx-card:hover { border-color: var(--bp-c-brand-1); transform: translateY(-2px); box-shadow: 0 16px 32px -20px rgba(0, 0, 0, 0.3); }
.dx-card h3 { margin: 0 0 0.4rem; font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-size: 1.05rem; font-weight: 600; color: var(--bp-c-text-1); }
.dx-card p { margin: 0; color: var(--bp-c-text-2); font-size: 0.9rem; line-height: 1.55; }
.dx-card code { font-size: 0.85em; padding: 0.1em 0.35em; }
.dx-more { display: inline-block; margin-top: 0.9rem; color: var(--bp-c-brand-1); font-size: 0.85rem; font-weight: 600; }
.dx-step { padding-top: 1.5rem; }
.dx-num { display: inline-grid; place-items: center; width: 30px; height: 30px; margin-bottom: 0.9rem; border-radius: 9px; background: var(--bp-c-brand-soft); color: var(--bp-c-brand-1); font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-weight: 700; font-size: 0.95rem; }
@media (max-width: 900px) { .dx-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .dx-grid { grid-template-columns: minmax(0, 1fr); } }
`,

    sidebar: {
      '/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is UptimeStatus', link: '/introduction' },
            { text: 'Quick start', link: '/getting-started' },
          ],
        },
        {
          text: 'Monitors',
          items: [
            { text: 'Overview', link: '/monitors/' },
            { text: 'Uptime', link: '/monitors/uptime' },
            { text: 'Ping', link: '/monitors/ping' },
            { text: 'TCP port', link: '/monitors/tcp-port' },
            { text: 'Cron & heartbeats', link: '/monitors/cron-heartbeats' },
            { text: 'Health checks', link: '/monitors/health-checks' },
          ],
        },
        {
          text: 'Certificates & DNS',
          items: [
            { text: 'SSL certificates', link: '/monitors/ssl' },
            { text: 'Domains', link: '/monitors/domains' },
            { text: 'DNS records', link: '/monitors/dns' },
            { text: 'DNS blocklists', link: '/monitors/dns-blocklist' },
          ],
        },
        {
          text: 'Performance & security',
          items: [
            { text: 'Performance', link: '/monitors/performance' },
            { text: 'Lighthouse', link: '/monitors/lighthouse' },
            { text: 'Broken links', link: '/monitors/broken-links' },
            { text: 'Port scan', link: '/monitors/port-scan' },
            { text: 'Server metrics', link: '/monitors/server-metrics' },
            { text: 'AI checks', link: '/monitors/ai-checks' },
          ],
        },
        {
          text: 'Operate',
          items: [
            { text: 'Incidents', link: '/operate/incidents' },
            { text: 'Notifications', link: '/operate/notifications' },
            { text: 'Status pages', link: '/operate/status-pages' },
            { text: 'Maintenance windows', link: '/operate/maintenance' },
          ],
        },
        {
          text: 'Self-hosting',
          items: [
            { text: 'Deploy', link: '/self-hosting/deploy' },
            { text: 'Configuration', link: '/self-hosting/configuration' },
            { text: 'Scaling & multi-region', link: '/self-hosting/scaling' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'CLI (buddy)', link: '/reference/cli' },
            { text: 'API', link: '/reference/api' },
          ],
        },
      ],
    },

    themeConfig: {
      // Brand palette + typefaces are applied via top-level `fonts` and the
      // `markdown.css` override above (bunpress's theme reads --bp-c-brand-* for
      // its accent, which markdown.css repoints to the marketing blue).
      darkMode: 'auto',
      footer: {
        message: 'Released under the MIT License.',
        copyright: 'Copyright 2024-present UptimeStatus',
      },
      socialLinks: [
        { icon: 'github', link: 'https://github.com/stacksjs/status' },
        { icon: 'bluesky', link: 'https://bsky.app/profile/uptime-status.org' },
      ],
    },
  },

  // SEO — the `/docs` pathname here sets the site's base path (see header note).
  sitemap: {
    enabled: true,
    baseUrl: 'https://uptime-status.org/docs',
  },

  robots: {
    enabled: true,
  },
}

export default config
