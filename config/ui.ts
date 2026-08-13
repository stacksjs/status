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
