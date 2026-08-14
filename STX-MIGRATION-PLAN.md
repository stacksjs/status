# status → stx-standards migration plan

Staged plan for bringing this app onto the stx standards
(`~/Documents/stx-standards`, filed upstream as stacksjs/stx#1791), the
way loghq and analyticshq already are and bughq mostly is. Produced from a
full compliance audit (2026-08-13) that read every subsystem, compared all
four sibling apps, and adversarially verified its own claims against the
vendored framework in `pantry/`.

**Where this app stood at audit time:** last of the four siblings on 9 of
12 rule clusters by *mechanism* (0 StxLink vs 251 plain anchors, 0
useSeoMeta, 0 stores, 30 of 48 pages hand-writing full documents, no
strict mode, 3-key config with inferred root) — while shipping the
family's best hand-authored SEO, its heaviest directive usage, zero
innerHTML, and honest in-file documentation for every deviation. "Well
built on the wrong architecture," so the migration is mostly mechanical.

**Two justifying beliefs were disproven during the audit — do not
re-derive decisions from them:**

1. *"Server scripts can't import app/ TS"* (various KEEP-IN-SYNC
   comments): **false in this build** — a static
   `import { fn } from '../../../app/lib/x'` inside a server block works.
   The ~140 mirrored CIDR/maintenance lines and ~22 display-helper copies
   have a sanctioned deletion path (Phase 5).
2. *"router/strict config isn't honored"*: **false in this build** —
   `pantry/bun-plugin-stx/dist/serve.js` forwards `strict`, `router`,
   `app`, and the SEO keys from `config/ui.ts`.

The genuinely load-bearing deviation stays: the documented, unresolved
`:for expected an array` hydration bug (see
`resources/views/dashboard/monitors/index.stx` header) is why the app is
server-rendered with plain scripts. That decision is respected until
Phase 6 re-tests it on an upgraded stx.

Push cadence: one phase = one commit (or a small commit series) = one
push. CI deploys `main` to prod, gated on lint + typecheck (app code) +
tests — every phase must go out green.

Pipeline status (2026-08-14): gates are green again (test job enters
buddy directly; package.json's `"system"` block — the hidden source of
pantry registry downloads — removed while registry.pantry.dev is down).
deploy-prod now reaches the real ts-cloud Hetzner deploy and fails at
SSH: the box (167.233.116.134) serves statushq.org and answers port 22
from a dev machine, but GitHub runners can't reach it within the 8-min
wait — an IP-allowlist/fail2ban question for ops, not a code defect.

---

## Phase 0 — Security hotfix + make the config true ✅ shipped 2026-08-14

**The leak (fixed here, verified empirically against the build's own
`generateServerDataBridge`):** stx serializes any server-block binding
into page HTML as `var name = <JSON>` when the name word-matches a plain
`<script>` in the assembled page and isn't redeclared there. On
`/dashboard/monitors`, the WS channel string `'team.'+TEAM_UUID+'.monitors'`
word-matched the raw `monitors` rows — emitting every monitor's
`metrics_token` (the agent-ingest credential the Monitor model explicitly
hides from API responses) into served HTML. Same mechanism exposed raw
passkey rows (public keys, counters) on `/dashboard/settings/security`
via the `/api/passkeys/*` URL strings.

- Fixed by the sibling apps' `__` discipline (`extractBridgeData` skips
  `__`/`$` names and functions) **plus** projection to display fields, so
  a future rename can't resurrect the leak: `monitors` → `__monitorRows`
  (projected), `passkeys` → `__passkeys` (projected), `SETUP` → `__SETUP`
  (defensive).
- Regression gate: `tests/unit/bridge-hygiene.test.ts` statically replays
  the bridge's exact matching rules over every view with includes
  flattened. It fails on any would-be emission. Fix findings by `__`
  rename/projection, never by allowlisting secrets.
- Comment landmine: literal `<script client>` text inside an HTML comment
  in `monitors/index.stx` broke script-boundary parsing (the constraint
  `partials/app-head.stx` documents). Rephrased; the hygiene test chokes
  on the same pattern, so recurrence gets caught.
- Config made true (stx-standards 01-topology): `config/ui.ts` pins
  `root: '.'` + `pagesDir`/`layoutsDir`/`partialsDir`/`storesDir`
  cwd-relative (both loaders agree; see the file's header comment),
  enables `strict` in warning mode, and sets
  `router.interceptAllLinks: false` (full-page loads become the explicit
  default instead of a 118-site `data-no-router` carpet).
- Dead starter scaffold deleted **atomically with the pin** (its
  existence was what drove root inference): `resources/layouts/Desktop.stx`,
  13 `resources/components/*.stx`, `resources/views/components/FeatureCard.stx`
  (was routed as a public page), 2 `resources/partials/welcome-pdf-*.stx`,
  `resources/functions/{counter,dark}.ts`, `resources/assets/styles/main.css`
  (1,532 dead lines), `resources/assets/scripts/main.ts`.
  `resources/functions/` keeps a README — the framework scans it
  unconditionally. `site-mode.js` is live (index.stx) and stays.
- Toolchain sees the config now: tsconfig `include` gains `.stx/*.d.ts`,
  `config/ui.ts`, `config/crosswind.ts` (so `satisfies UiOptions` is
  finally evaluated) and drops the phantom `app/Services|Support` globs.
  Pre-commit lint glob gains `stx`. Full `config/**` and `app/**`
  inclusion is Phase 7 (measured: 11 upstream-type errors in stock config
  scaffold, 272 in app/ — not this phase's fight).

**Verify:** bridge-hygiene test red on the pre-fix tree, green after;
full suite + app-code typecheck + `buddy lint` + pickier green.

## Phase 1 — Centralize the head ✅ shipped 2026-08-14

- `config/ui.ts` gains `app.head.link` (favicon trio, font preconnects +
  stylesheet), `defaultTitle`, `defaultDescription`, `skipDefaultSeoTags`
  — all serve-forwarded. NOT charset/viewport: the fragment shell
  auto-emits its own pair, so config copies double them (verified against
  document-shell.js). The per-page favicon/preconnect/font lines came out
  of marketing-head.stx, app-head.stx, index.stx, login.stx and
  register.stx — which also retires login/register's divergent fonts URL
  (they were missing JetBrains Mono).
- Status-page titles single-sourced: the layered `useHead` hotfix was
  built on a false premise (the pages were never fragments — `'stx App'`
  was an upstream shell-detection bug, since fixed in the vendored stx)
  and shipped a live double-`<title>` where the layout's copy won. Now
  one `@section('title', docTitle)` with the `'<page> status'` wording
  the original fa62575 commit intended. `invite/[uuid].stx` keeps its
  `useHead` — it is a genuine fragment.
- Token drift fixed: `--danger`/`--danger-soft`/`--amber-soft` added to
  all three token blocks in marketing-head.stx and index.stx (crosswind
  maps them; `bg-danger-soft` resolved to nothing on marketing pages).
- Deliberately deferred: folding index.stx's inline design-system copy
  into the partial happens in Phase 2 (the page converts to the marketing
  layout anyway); theme pre-paint scripts stay per-page until Phase 5
  because the status layout's forced-theme resolver has different
  semantics than the marketing/app copies — a config-level script would
  override a server-stamped forced theme.
- Landmine met and defused: deleting the partials' font links left the
  theme pre-paint script as the partial's FIRST element, which stx strips
  as the partial's "component script" (empirically reproduced — exactly
  the constraint the partial header documents). Both head partials are
  now style-first with scripts after, and a `{{-- --}}` note guards the
  ordering.
- Shipped alongside: CI had been red for three weeks — every
  `source: pantry` system-binary download (bun.sh/sqlite.org/zlib/
  readline/ncurses) fails with DownloadFailed because registry.pantry.dev
  502s (confirmed directly; npm packages unaffected). GitHub Actions
  needs none of those binaries (setup-bun provides bun, tests use
  bun:sqlite, mysql/redis are workflow services), so config/deps.ts now
  skips system-binary provisioning when GITHUB_ACTIONS is set. Dev
  machines and the deploy box still resolve the full set. **The registry
  outage itself is org infra and still needs fixing** — fresh machine
  bootstraps and fresh box provisioning stay broken until then.

## Phase 2 — One shell, one layout ✅ complete 2026-08-14 (3 batches)

Batch 1: real `layouts/marketing.stx` + all 25 uniform pages (19
features/*, 6 for/*) converted to `@extends` + six two-arg sections +
`@section('content')`. Every page verified against a pre-conversion
baseline render: `<main>` interior byte-identical, head tag-set
identical, exactly one DOCTYPE/title. Engine facts learned (all
empirically): a `@yield` consumes its section (second use renders
empty — hence separate ogTitle/ogUrl sections); directive-looking text
inside `{{-- --}}` comments is LIVE (a literal extends-directive naming
the layout inside the layout's own comment recursed until OOM); two-arg
section args are parsed naively, so values containing apostrophes must
use block-section form (raw text, yields trimmed). Batch 2 (same day): compare
and docs — same uniform shape, but two engine facts of their own: section
content resolves @include paths LAYOUT-relative (root-level pages'
`./partials/` broke; `../partials/` resolves identically from both
bases, which is why the features/for pages never noticed), and the
section-arg evaluator handles only a single string concatenation (a
three-part `"a" + x + "b"` renders empty — block-section form instead).
Batch 3: login and register
moved onto a new document-owning `layouts/auth.stx` (noindex, no
nav/footer, the union of their formerly-duplicated card styles — they
were byte-identical apart from four small hunks). index.stx deliberately
stays a self-owned document — its host-multiplexed custom-domain status
branch, coming-soon overlay, dynamic `<html>`/`<body>` attributes and
og:site_name/twitter slots genuinely do not fit the marketing layout —
but its sync debt is gone: the 104 rules duplicated from
marketing-head.stx plus tokens/resets/theme-script were deleted
(2,054 → 1,437 lines) in favor of including the partial, with the five
deliberate homepage-scale overrides kept after the include so the
cascade preserves them, and its hand-rolled nav swapped for
partials/marketing-nav.stx (byte-equivalent render, 32 anchors). The
hand-rolled footer stays for now — it has 4 link blocks vs the partial's
5, a content difference to settle separately (a .footer-grid 3-column
override keeps its layout correct). All three verified against
pre-conversion baselines: main interior byte-identical, head tag-set
identical (the only normalized delta is the framework runtime block's
injection indent).

- Create a document-owning `layouts/marketing.stx` on the proven
  `layouts/status.stx` pattern (`@yield('lang')`/`@yield('theme')` on
  `<html>` is the deliberate deviation to keep).
- Convert the 30 hand-rolled DOCTYPE documents (19 `features/*`, 6
  `for/*`, index, compare, docs, login, register) to
  `@extends` + `@section('content')`, batch of 4-6 pages per commit.
- Risk (from the standards): an unfilled `@section` yields a blank page,
  not an error. Verify per page: exactly one `<main>`, one `<title>`,
  byte-diff of `<main>` interior against pre-migration render is empty.
- Render harness (proven on features/uptime-monitoring.stx): pages render
  headlessly via `NODE_PATH=<repo>/pantry bun` + `processDirectives` from
  `pantry/@stacksjs/stx/dist/process.js` with the pinned dirs from
  config/ui.ts — no dev server needed for the per-page byte-diffs.
- Delete the dead `resources/views/layouts/marketing.stx` document-style
  layout first; it was never resolvable.

## Phase 3 — SEO from one source

- Port the 28 complete hand-written marketing heads to `useSeoMeta`
  (transcription, not authoring — title/description/canonical/og already
  exist as tags).
- Add an og:image asset + per-page `ogImage`; emit FAQPage JSON-LD from
  the 25 existing server-script `faqs` arrays (one array, two consumers —
  unusually pre-positioned); add `/docs` to the sitemap.
- Rewrite `resources/emails/subscription-confirmation.stx` (unbranded
  Stacks boilerplate, live via SubscriptionConfirmation.ts).

## Phase 4 — Links, then the flip

Strictly after Phase 2 (the standards' own ordering — converting links
first ships unstyled fragment swaps across shell boundaries):

- Adopt `StxLink` group-by-group with `interceptAllLinks: false` already
  set (opt-IN model, the loghq end-state): nav partials first (covers
  every page's chrome), then dashboard filter chips (today they
  mixed-swap/reload — a real bug), then in-body links.
- Delete the ~118 now-redundant `data-no-router` attributes, keeping the
  documented `/api/` SSO redirect exceptions.
- When the dashboard opts in, add router-navigation teardown for the WS
  client + intervals in `monitors/index.stx` (today they die with the
  full-page unload; fragment swaps would leak them).
- Emit `aria-current` via StxLink's active state (a dead CSS rule for it
  already exists).

## Phase 5 — State and data

- Replace the 47 `require()` sites and every KEEP-IN-SYNC block with
  static imports from `app/` (verified working): the ~140 mirrored
  CIDR/maintenance lines in `status/[slug].stx` import from
  `app/Actions/StatusPages/AccessControl.ts` and `app/lib/maintenance.ts`
  instead; the ~22 display-helper copies (stClass/stLabel/agoLabel/
  fmtDuration/…) consolidate into `app/lib` modules.
- Migrate the 3 straggler pages (`settings/security.stx`,
  `status-reports/index.stx`, `status-reports/[id].stx`) from hand-rolled
  first-membership auth to the switcher-aware `resolveTeamContext` the
  other 12 dashboard pages use — the drift is user-visible today.
- Consolidate the 9 live theme-script copies into one shared static asset
  (a real store stays gated on the hydration bug, Phase 6).

## Phase 6 — Components (framework-upgrade-gated)

- Upgrade `@stacksjs/stx` + `stx-router` off the 0.2.82 pin to ≥0.2.176
  (the pin predates the fixes for 36 broken library components).
- **Re-test the `:for` hydration bug** that justifies the plain-script
  architecture; record the result in `monitors/index.stx`'s header either
  way.
- Then wire `@stacksjs/components`, replace the 4 `onsubmit`-confirm
  attributes with `stxConfirm`, adopt `<Icon>` for the 54 inline SVGs.

## Phase 7 — Types, styling volume, and the ratchet

- Annotate the 125 untyped server-block functions as files are touched
  (rule 10: they compile as TypeScript today with every param silently
  `any`); build real ambient types in `types/`.
- Expand tsconfig include to `config/**` (11 errors to fix) and `app/**`
  (272), then let CI gate them.
- Migrate the ~3,172 inline CSS lines toward Crosswind utilities via the
  documented semantic-token bridge (`dashboard/index.stx:259` is the
  in-repo example).
- Ratchet: `strict.failOnViolation: true`, allowPatterns as a formal
  exception ledger (analyticshq's model).

---

## Leave alone — looks wrong, is deliberate

- **Server-rendered plain scripts instead of signals/`<script client>`**
  — documented framework-bug workaround; re-evaluated in Phase 6, not
  before.
- **Relative-path `@include('../partials/x.stx')` everywhere** — this is
  what made the old config misresolution harmless (bughq shipped
  path-dump pages from the same misconfiguration). Keep the style even
  though the config is now pinned.
- **`requestContext` cookie access in server blocks** — framework-provided
  hook in this build; the comments calling it a workaround are stale, the
  mechanism is correct.
- **Server-side fail-closed auth on every dashboard page** — better than
  the standards' client-guard allowlist; do not "migrate" it to client
  guards.
- **`site-mode.js`** — live coming-soon gate referenced by `index.stx`,
  not the dead bughq twin.
