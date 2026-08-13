import type { StxOptions as UiOptions } from '@stacksjs/stx'

/**
 * STX configuration (stx-standards 01-topology: config as root).
 *
 * Topology is pinned explicitly so directory presence never decides it —
 * before this, `root` was inferred as 'resources' purely because the dead
 * starter `resources/layouts/Desktop.stx` existed (deleted in the same
 * commit that pinned these keys; the two changes are only correct
 * together).
 *
 * Two loaders read this file and they disagree about `root`:
 *  - loadStxConfig (SSG, store-loader, crosswind discovery) honors every
 *    key here, root-prefixing the template dirs;
 *  - the dev/prod serve path hardcodes root to process.cwd() and forwards
 *    an allowlist (componentsDir/layoutsDir/partialsDir/strict/router/
 *    app/seo keys — verified against pantry/bun-plugin-stx/dist/serve.js).
 * With `root: '.'` both loaders resolve identical cwd-relative paths, so
 * every dir below is written cwd-relative. Keep it that way.
 */
export default {
  root: '.',

  // Pages: the only routable tree. Layouts/partials live inside it (their
  // relocation out of pagesDir is tracked in STX-MIGRATION-PLAN.md).
  pagesDir: 'resources/views',

  // No app components yet — the starter scaffold that used to sit in
  // resources/components was unreferenced and is deleted. Future
  // components go here (Phase 6 of the migration plan).
  componentsDir: 'resources/components',

  // The real layouts (default/marketing/status). resources/layouts held
  // only dead starter scaffold and is gone; without this pin its mere
  // existence used to flip root inference.
  layoutsDir: 'resources/views/layouts',

  // All @include calls in views use explicit relative paths with the .stx
  // extension, so they resolve independently of this key — pinned anyway
  // so both loaders agree on the same real directory.
  partialsDir: 'resources/views/partials',

  // No stores yet (server-rendered architecture; see the migration plan's
  // Phase 5). Pinned now so store adoption later is a file-add, not a
  // topology change. store-loader resolves path.resolve(root, storesDir).
  storesDir: 'resources/stores',

  // Shared head assets for every page (stx-standards 04-head). Full
  // documents get these via injectConfigHeadTags (href-deduped against
  // whatever the page already wrote); fragments get them merged into the
  // generated shell. charset/viewport are NOT listed: the fragment shell
  // auto-emits its own pair, so config copies would double them
  // (verified against pantry/@stacksjs/stx/dist/document-shell.js).
  // Theme pre-paint scripts stay per-page: the public status pages run a
  // forced-theme resolver with different semantics, and a config-level
  // script would override a server-stamped forced theme.
  app: {
    head: {
      link: [
        { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
        { rel: 'icon', href: '/favicon-32.png', type: 'image/png', sizes: '32x32' },
        { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
        { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
        { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: 'anonymous' },
        { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap' },
      ],
    },
  },

  // Fallbacks for fragment views that forget useHead — replaces the
  // framework's 'stx App' stamp customers used to see in the tab.
  defaultTitle: 'StatusHQ',
  defaultDescription: 'Uptime, SSL, DNS and server monitoring with public status pages.',

  // Pages own their SEO tags (every marketing page hand-writes a full
  // head today; Phase 3 ports them to useSeoMeta). Keep the framework's
  // generic og/twitter injector out of the way.
  skipDefaultSeoTags: true,

  // Warning mode first (stx-standards 12-enforcement): surface prohibited
  // DOM usage as a migration work queue without failing builds. Ratchet to
  // failOnViolation: true at the end of the migration (Phase 7).
  strict: {
    enabled: true,
    failOnViolation: false,
  },

  // The app is a server-rendered MPA today: most pages are self-shelled
  // documents where fragment swaps would break, which is why 118
  // data-no-router escape hatches existed. Opting OUT of global link
  // interception makes full-page loads the explicit default (and lets
  // Phase 4 adopt StxLink per link group, the loghq/bughq end-state,
  // instead of maintaining the opt-out carpet).
  router: {
    interceptAllLinks: false,
  },
} satisfies UiOptions
