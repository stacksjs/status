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

    // UptimeStatus docs theme — reskins bunpress to the marketing design
    // system (uptime-status.org). bunpress folds `markdown.css` into every
    // page additively (after the theme CSS), so repointing the ~15 SEMANTIC
    // tokens below cascades through nav, sidebar, content and code — then a few
    // component overrides (nav, hero buttons, cards) carry the polish across.
    css: `
/* ---- Palette: light (marketing --bg/--surface/--fg/--muted/--accent) ---- */
:root {
  --bp-c-bg: #fbfbfa;
  --bp-c-bg-alt: #ffffff;
  --bp-c-bg-elv: #ffffff;
  --bp-c-bg-soft: #f2f3f1;

  --bp-c-border: rgba(11, 15, 13, 0.14);
  --bp-c-divider: rgba(11, 15, 13, 0.08);
  --bp-c-gutter: rgba(11, 15, 13, 0.06);

  --bp-c-text-1: #0b0f0d;
  --bp-c-text-2: #5c6864;
  --bp-c-text-3: #8a938c;

  --bp-c-brand-1: #2563eb;
  --bp-c-brand-2: #3b82f6;
  --bp-c-brand-3: #60a5fa;
  --bp-c-brand-soft: rgba(37, 99, 235, 0.10);

  --bp-font-family-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ---- Palette: dark ---- */
.dark {
  --bp-c-bg: #080b0a;
  --bp-c-bg-alt: #101413;
  --bp-c-bg-elv: #101413;
  --bp-c-bg-soft: #161b19;

  --bp-c-border: rgba(255, 255, 255, 0.13);
  --bp-c-divider: rgba(255, 255, 255, 0.07);
  --bp-c-gutter: rgba(255, 255, 255, 0.05);

  --bp-c-text-1: #f2f5f3;
  --bp-c-text-2: #97a39d;
  --bp-c-text-3: #6f7a75;

  --bp-c-brand-1: #60a5fa;
  --bp-c-brand-2: #3b82f6;
  --bp-c-brand-3: #2563eb;
  --bp-c-brand-soft: rgba(96, 165, 250, 0.16);
}

/* ---- Typography: Space Grotesk display, tight tracking (marketing) ---- */
h1, h2, h3, h4, h5, h6,
.BPHomeHero .name, .BPHomeHero .text, .hero-container .name, .hero-container .text {
  font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.02em;
}
.BPHomeHero .text, .hero-container .text { line-height: 1.08; }

/* ---- Nav bar: translucent + blurred + hairline border (marketing nav) ---- */
.BPNav {
  background: color-mix(in srgb, var(--bp-c-bg) 80%, transparent);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--bp-c-divider);
}
.BPNavBarTitle { font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.01em; }

/* ---- Hero action buttons: marketing .button / .button.primary ---- */
.BPButton { border-radius: 12px; font-weight: 600; height: 46px; padding: 0 1.2rem; font-size: 0.95rem; }
.BPButton-brand { background: var(--bp-c-brand-1); border: 1px solid var(--bp-c-brand-1); color: #ffffff; }
.BPButton-brand:hover { filter: brightness(1.06); }
.BPButton-alt { background: var(--bp-c-bg-elv); border: 1px solid var(--bp-c-border); color: var(--bp-c-text-1); }
.BPButton-alt:hover { border-color: var(--bp-c-brand-1); color: var(--bp-c-brand-1); background: var(--bp-c-bg-elv); }

/* ---- Hero: more top room + a right-side status-dashboard visual.
   !important because the hero template ships its own inline <style> with
   equal-specificity rules that would otherwise win on source order. ---- */
.BPHomeHero { padding-top: 132px !important; padding-bottom: 44px !important; }
.hero-container { align-items: center !important; }
.hero-content { flex: 1 1 auto !important; }
.hero-image { flex: 0 0 auto !important; width: min(46%, 500px) !important; margin-top: 0 !important; }
.hero-image img { max-width: 100% !important; width: 100% !important; height: auto !important; }
@media (max-width: 959px) {
  .BPHomeHero { padding-top: 100px !important; }
  .hero-image { width: 100% !important; max-width: 440px !important; margin-top: 24px !important; }
}

/* ---- Home landing: marketing sectioned card grids ---- */
.dx-section { max-width: 1152px; margin: 0 auto; padding: clamp(2.5rem, 6vw, 4rem) 24px 0; }
.dx-section:last-of-type { padding-bottom: 3rem; }
.dx-head { max-width: 44rem; margin: 0 0 1.75rem; }
.dx-eyebrow { display: block; margin-bottom: 0.6rem; color: var(--bp-c-brand-1); font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
.dx-title { margin: 0 0 0.5rem; font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-size: clamp(1.55rem, 3vw, 2.05rem); font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; }
.dx-lead { margin: 0; color: var(--bp-c-text-2); font-size: 1.05rem; line-height: 1.6; }
.dx-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1rem; }
a.dx-card { display: block; position: relative; padding: 1.6rem; border: 1px solid var(--bp-c-divider); border-radius: 16px; background: var(--bp-c-bg-elv); color: var(--bp-c-text-1); text-decoration: none !important; box-shadow: 0 1px 2px rgba(11, 15, 13, 0.03); transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease; }
a.dx-card:hover { border-color: var(--bp-c-brand-1); transform: translateY(-2px); box-shadow: 0 18px 34px -22px rgba(11, 15, 13, 0.32); }
.dx-card h3 { margin: 0 0 0.4rem; font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-size: 1.05rem; font-weight: 600; color: var(--bp-c-text-1); }
.dx-card p { margin: 0; color: var(--bp-c-text-2); font-size: 0.9rem; line-height: 1.55; }
.dx-card code { font-size: 0.85em; padding: 0.1em 0.35em; }
.dx-more { display: inline-block; margin-top: 0.9rem; color: var(--bp-c-brand-1); font-size: 0.85rem; font-weight: 600; }
.dx-step { padding-top: 1.5rem; }
.dx-num { display: inline-grid; place-items: center; width: 30px; height: 30px; margin-bottom: 0.9rem; border-radius: 9px; background: var(--bp-c-brand-soft); color: var(--bp-c-brand-1); font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-weight: 700; font-size: 0.95rem; }
@media (max-width: 900px) { .dx-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .dx-grid { grid-template-columns: minmax(0, 1fr); } }

/* ---- Marketing footer (injected into every page by scripts/build-docs.ts) ---- */
.dx-footer { border-top: 1px solid var(--bp-c-divider); margin-top: 5rem; }
.dx-footer-inner { max-width: 1152px; margin: 0 auto; padding: 3.5rem 24px 2.5rem; }
.dx-footer-grid { display: grid; grid-template-columns: 1.6fr repeat(4, 1fr); gap: 2rem; margin-bottom: 2.5rem; }
.dx-footer .dx-brand { display: inline-flex; align-items: center; gap: 0.6rem; color: var(--bp-c-text-1); text-decoration: none !important; }
.dx-footer .dx-brand-mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px; color: #fff; background: var(--bp-c-brand-1); }
.dx-footer .dx-brand-mark svg { width: 16px; height: 16px; }
.dx-footer .dx-brand-name { font-family: "Space Grotesk", ui-sans-serif, system-ui, sans-serif; font-size: 1.1rem; font-weight: 600; letter-spacing: -0.01em; }
.dx-footer-brand p { max-width: 20rem; margin: 0.85rem 0 0; color: var(--bp-c-text-2); font-size: 0.9rem; line-height: 1.6; }
.dx-footer-col h4 { margin: 0 0 1rem; color: var(--bp-c-text-2); font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.dx-footer-col ul { display: grid; gap: 0.6rem; margin: 0; padding: 0; list-style: none; }
.dx-footer-col a { color: var(--bp-c-text-1); font-size: 0.9rem; text-decoration: none !important; }
.dx-footer-col a:hover { color: var(--bp-c-brand-1); }
.dx-footer-bottom { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-top: 1.75rem; border-top: 1px solid var(--bp-c-divider); color: var(--bp-c-text-2); font-size: 0.85rem; }
.dx-footer-social { display: flex; gap: 0.75rem; }
.dx-footer-social a { display: grid; place-items: center; width: 36px; height: 36px; border: 1px solid var(--bp-c-divider); border-radius: 999px; color: var(--bp-c-text-2); text-decoration: none !important; }
.dx-footer-social a:hover { color: var(--bp-c-text-1); border-color: var(--bp-c-border); }
.dx-footer-social svg { width: 17px; height: 17px; }
@media (max-width: 900px) { .dx-footer-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .dx-footer-grid { grid-template-columns: minmax(0, 1fr); } .dx-footer-bottom { flex-direction: column; align-items: flex-start; gap: 0.75rem; } }
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
