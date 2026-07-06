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

    // Load the marketing site's typefaces so the docs match.
    fonts: {
      google: [
        'Space+Grotesk:wght@500;600;700',
        'Inter:wght@400;500;600;700',
        'JetBrains+Mono:wght@400;600',
      ],
    },

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
      // Brand knobs (accent + typefaces) for bunpress's theme. NOTE: the
      // installed bunpress (0.1.9) ships its default theme and does not yet
      // honor these — they're declared for the theme version that does, so a
      // bunpress bump brands the docs to the marketing palette (blue accent,
      // Space Grotesk display, Inter body) with no further change.
      colors: {
        accent: '#2563eb',
      },
      fonts: {
        heading: '"Space Grotesk", ui-sans-serif, system-ui, sans-serif',
        body: '"Inter", ui-sans-serif, system-ui, sans-serif',
        mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      },
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
