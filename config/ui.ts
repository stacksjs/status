import type { StxOptions as UiOptions } from '@stacksjs/stx'
import { env } from '@stacksjs/env'
import { tsAnalyticsStxConfig } from '@ts-analytics/tracking/stx'

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
  // Page views to analyticshq. Not layout-coupled: stx injects the tag in
  // processOtherDirectives, the shared tail of both the layout and no-layout
  // render branches, so all five layouts here are covered. The two fragment
  // layouts (default, home) have no </head>, so on those the tag is appended
  // into <body> instead — still fires, but grep the whole document rather than
  // the head when checking a dashboard page.
  //
  // `apiEndpoint` is named rather than left to the package default, which was
  // http://localhost:2027 in every release up to 0.1.13 — over HTTPS that is
  // blocked as mixed content, silently, so an app supplying only an App ID
  // beacons at nothing.
  //
  // `?? ''` because env.d.ts types this key `string | undefined` while `appId`
  // is a required string, and because the package documents a blank App ID as
  // inert — the same "unset means off" path as a missing variable rather than
  // a second way to be broken.
  analytics: tsAnalyticsStxConfig({
    appId: env.ANALYTICSHQ_APP_ID ?? '',
    apiEndpoint: 'https://analyticshq.org',
  }),

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

  // Opt-IN navigation (the loghq/bughq end-state, adopted in migration
  // Phase 4): only <StxLink> anchors SPA-navigate; every plain <a> is a
  // full page load. StxLink is used for same-shell destinations
  // (marketing<->marketing, dashboard<->dashboard); links that cross a
  // shell family (marketing -> /login|/register|/dashboard, anything ->
  // /status/*) stay plain anchors ON PURPOSE - a fragment swap across
  // shells would inject one document family's content into another's.
  // /api/* links (SSO/OAuth server redirects) also stay plain and keep
  // an explicit data-no-router as documentation.
  router: {
    interceptAllLinks: false,

    // OFF because hover-prefetch corrupts the routed container's layout.
    //
    // The server sends the destination container's own attributes in
    // X-STX-Container-Attrs -- for every dashboard route that is
    // `class="app-shell"`, which supplies the max-width and centring. The
    // router's navigate path caches that alongside the HTML. Its two
    // PREFETCH paths do not: they never read the header, and they call
    // setCache with five arguments instead of six, so the entry lands with
    // an empty attribute string.
    //
    // Click a link you hovered first and the cache hit applies '' to the
    // container. setContainerAttrs then walks data-stx-cattrs from the last
    // navigation, finds `class` absent from the incoming (empty) map, and
    // REMOVES it -- so <main class="app-shell"> becomes <main>, and the page
    // renders edge to edge with a horizontal scrollbar.
    //
    // That is why it looked intermittent and why a hard reload always
    // "fixed" it: it only happens when the link was prefetched, and a full
    // load rebuilds the document from server HTML. Prefetch is a latency
    // optimisation; correct layout is not optional, so it stays off.
    //
    // Re-checked against stx 0.2.231 (the router was rewritten between
    // 0.2.198 and 0.2.231 — it is inlined into the page now rather than
    // served as /_stx/router.js). Still broken, and now down to exactly one
    // call site. `setCache(key, html, layout, group, title, cattrs)` takes
    // six; the navigate path reads X-STX-Container-Attrs into newCAttrs and
    // passes all six, while the prefetch path's response handler reads only
    // X-STX-Layout / -Layout-Group / -Title / -Runtime and calls
    //   setCache(key, result.html, result.layout, result.layoutGroup, result.title)
    // with five, so the entry lands with cattrs undefined. Turn this on
    // again only after that handler reads the container-attrs header.
    prefetch: false,
  },
} satisfies UiOptions
