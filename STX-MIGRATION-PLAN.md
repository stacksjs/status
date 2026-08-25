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
SSH.

Re-diagnosed 2026-08-17, and the earlier "runners are firewalled out"
reading was wrong: the box (167.233.116.134) completes a full SSH
handshake from an ordinary, non-allowlisted IP and answers `Permission
denied (publickey,password)`, so nothing is filtering by source address.
The readiness probe is `ssh root@ip true` with `BatchMode=yes`, and
`pollUntil` treats *any* failure the same, so a key rejected in 0.2s is
reported as "SSH did not become reachable … the box may still be
booting". ~96 instant retries over 8 minutes is the signature of
rejection, not of a slow boot. Last successful deploy was 2026-07-16;
the next run, 2026-07-25, failed, and between them sits exactly one
commit — a docs link change — so the cause is environmental (the
`DEPLOY_SSH_PRIVATE_KEY` secret or `root`'s `authorized_keys`), not in
this repo. Ops check: compare `ssh-keygen -y -f` on the secret against
`/root/.ssh/authorized_keys`, then `fail2ban-client status sshd`, since
three weeks of failed auth may have banned the runners on top.

Consequence worth stating plainly: production has served pre-rename July
code since then, so none of Phases 0–5 is live — including the Phase 0
credential-leak fix.

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

## Phase 3 — SEO from one source ✅ shipped 2026-08-14

- All 30 pages now declare SEO via `useSeoMeta`/`useHead` in their
  server scripts (rule 5): the marketing/auth layouts dropped their
  title/description/canonical/og yields, og:title/og:description and the
  twitter pair derive from title/description, and every page was
  verified against pre-port baselines (main byte-identical; the only
  head deltas are the derived twitter tags, framework entity-escaping of
  attribute values, and og:title now robust where section-eval could
  render it empty). Engine facts: the server-side `useSeoMeta` ignores
  its `canonical` key (canonical + og:url go through `useHead`), and
  auth pages use plain `useHead` so noindex surfaces don't grow og tags.
- FAQPage JSON-LD emitted from the existing `faqs` arrays on all 24
  faq-bearing pages plus the homepage, via `useHead` script entries with
  `<` escaped so markup in answers can't close the script.
- Sitemap still pointed at uptime-status.org — 27 URLs the rename never
  touched — now statushq.org, plus `/docs`.
- The subscriber confirmation email really did ship 'Welcome to Stacks'
  with stacksjs.com links: the caller never passed `appName`, so the
  template's scaffold defaults won. Caller now passes brand props and
  the template defaults are StatusHQ.
- Still open: an og:image asset (1200×630) needs design; wire per-page
  `ogImage` keys once it exists.

## Phase 4 — Links, then the flip ✅ shipped 2026-08-14

- 172 internal anchors adopted `StxLink` under the opt-in model
  (`interceptAllLinks: false`): both nav partials + footer, the
  dashboard chrome and filter chips, and every same-shell in-body link.
  Cross-shell destinations (marketing → /login|/register|/dashboard,
  anything → /status/*) stayed plain full-load anchors, and /api/* SSO
  links keep an explicit data-no-router as documentation — the other 81
  carpet attributes are gone.
- **Superseded 2026-08-25: the cross-shell carve-out is withdrawn.** The
  remaining 69 anchors were converted, leaving only the four categories
  that must full-load (see AGENTS.md § Links). The carve-out was
  over-cautious rather than wrong-headed: nobody had checked what the
  router does when the layout changes. It compares layout groups
  (`meta[name="stx-layout-group"]`, else a name derived from the layout)
  and does a full document load when they differ — `checkLayoutChange`,
  "Only truly different layout groups trigger a full page reload". This
  app serves five distinct groups (`marketing`, `auth`, `status`,
  `default`, and `app` for the layout-less homepage), so every cross-shell
  hop already full-loaded on its own. The carve-out was hand-maintaining a
  rule the engine enforces.
- Engine contract (fixture-verified before adoption): StxLink SSR
  renders plain crawlable `<a href … data-stx-link>` anchors; the
  client's default is opt-in interception, and `data-stx-link` clicks
  bypass `shouldIntercept`, so even same-path filter chips SPA-navigate
  (the bughq chip bug cannot occur). Active classes are applied
  client-side via `data-stx-active-class`; the client dispatches
  `stx:navigate` / `stx:load`.
- `monitors/index.stx` tears down its WebSocket and label-refresh
  interval on `stx:navigate` — a fragment swap away from the page no
  longer leaks them.
- Verified: all 30 marketing/auth pages render byte-identical to
  pre-conversion baselines modulo the expected attribute deltas
  (data-stx-* additions, data-no-router removals, StxLink dropping
  empty class="" attributes, attribute reordering); all 15 dashboard
  views pre/post-diffed with the same normalization — only the expected
  deltas appear.

## Phase 5 — State and data ✅ shipped 2026-08-17 (5 commits)

Every item landed; ~470 lines of duplication deleted.

- **Straggler auth pages** (`settings/security.stx`,
  `status-reports/index.stx`, `status-reports/[id].stx`) now use
  `resolveTeamContext`. This was user-visible: they resolved the team by
  taking the user's highest-priority active membership, so switching
  workspace and opening Announcements listed the *other* team's reports,
  and the switcher control never rendered on those pages at all
  (`partials/app-nav.stx` guards on `SWITCHABLE_TEAMS` being defined).
- **Display helpers** → `app/lib/display.ts` (32 copies in 12 blocks).
  They had drifted into contradicting each other: `stLabel` in three
  versions meant one paused monitor read "Paused" on its detail page,
  "Pending" on the list, "Unknown" on a status page. `formatDate` in
  four (12h/24h, year, empty label, two with no Invalid-Date guard) →
  one function with options. A fifth date formatter hid under the name
  `dateLabel`. Canonical labels now cover all five values the
  `monitors.status` CHECK allows.
- **KEEP-IN-SYNC mirrors deleted** from `status/[slug].stx`: ~105 lines
  of IPv4/IPv6 CIDR matching (an *access-control* decision, untested in
  its copied form) and ~60 lines of maintenance-interval maths now
  import the canonical, unit-tested versions.
- **`require()` → static imports**, all 50 sites in 17 views.
- **Theme scripts** → `partials/theme-init.stx` +
  `partials/theme-toggle.stx` (6 copies). Included, not moved to a
  static asset: the applier must run before first paint, and an external
  script would add the round-trip that causes the flash it prevents.
  `layouts/status.stx` keeps its own — an owner-forced theme needs a
  resolver that leaves a server-stamped value alone. Dead
  `partials/theme.stx` deleted (nothing included it; it read a different
  localStorage key).

**stx constraints found here — they shape Phases 6 and 7:**

1. `import { x as y }` in a server block **binds undefined**. Import the
   real name and rename with a following `const`.
2. ~~Every import must sit above the first statement of the block.~~
   **Retracted 2026-08-18** — this was a false inference. `monitors/[id].stx`
   has imports on both sides of two `const` statements and binds all 122 of
   its variables. The breakage that produced this rule was constraint 3
   alone: moving the import up did not fix `status-reports/[id].stx`,
   removing the name collision did.
3. Imports collide with same-named local functions
   (`status-reports/[id].stx` had its own `statusLabel` for report
   status). A collision fails the whole block, not just that name.

Both 1 and 2 fail *silently*: no throw, no log, just an unbound name and
a page missing content. `tests/unit/display.test.ts` and the block-probe
approach (evaluate a view's server block and assert the variables it
must define) are what caught them; a renderer diff alone would not have.

**Not consolidated, deliberately:** the browser copies of
`stClass`/`stLabel` in `monitors/index.stx`. A client script cannot
import app/ TS, and it rewrites the same cells over the WebSocket, so it
is pinned to the module by a test that evaluates the copy out of the
view and diffs it against `statusLabel` for every status value.

## Phase 6 — Components (framework-upgrade-gated)

**Version split found 2026-08-17 — do this before the deploy unblocks.**
Three different stx versions are in play: `package.json` asks for
`^0.2.82`, `node_modules` resolves 0.2.82, the vendored
`pantry/@stacksjs/stx` is **0.2.76**, and the Hetzner deploy's own pantry
install resolved **0.2.179** (all inside that caret range). So the next
successful deploy would jump the render engine ~100 versions past
anything tested here, unreviewed. Pin deliberately, then upgrade on
purpose.

- Upgrade `@stacksjs/stx` + `stx-router` off the 0.2.82 pin to ≥0.2.176
  (the pin predates the fixes for 36 broken library components).
- **Re-test the `:for` hydration bug** that justifies the plain-script
  architecture; record the result in `monitors/index.stx`'s header either
  way.
- Then wire `@stacksjs/components`, replace the 4 `onsubmit`-confirm
  attributes with `stxConfirm`, adopt `<Icon>` for the 54 inline SVGs.

## Phase 7 — Types, styling volume, and the ratchet

**The gate was vacuous until 2026-08-17.** CI ran `bunx --bun tsc`, which
segfaults here (Bun 1.3.1, "panic: Segmentation fault"). A crash emits no
`error TS` lines, the grep found nothing, and the job reported "App code
typechecks clean" regardless of what was broken. Fixed by running
Node-hosted `bunx tsc` and failing when tsc produces no diagnostics at
all. Re-measure before trusting any earlier count in this file.

Real counts under an expanded include, measured with working tsc:

| area | errors |
| --- | --- |
| `tests/feature` | 386 |
| ~~`app/Actions` + `app/Jobs`~~ | 228 → **0, now gated** |
| `tests/unit` | 12 |
| `config/**` | 11 (upstream scaffold types) |
| ~~`app/lib`~~ | 5 → **0, now gated** |

**How app/Actions went to zero (2026-08-17).** 167 of the 228 were one
root cause: bun-query-builder declares `createModel(): void` although it
returns the model, so `defineModel` cast through `Record<string, unknown>`
and every model static — `Monitor.where`, `Monitor.find`,
`CheckResult.create` — resolved to `unknown`. A `StacksModelStatics`
interface on that cast fixed all of them at once. The rest were four
more upstream gaps, each fixed at the source rather than cast away at
~40 call sites:

- `RequestInstance` was referenced as a global that app files can't see;
  it is exported from `@stacksjs/types` and is now imported explicitly
  (8 files).
- `RequestInstance` didn't declare `cookie()` or `text()`, both of which
  bun-router implements — so working code read as "property does not
  exist".
- `ActionValidations.rule` restated ts-validation's contract by hand and
  had drifted from it, so `schema.string()` — the documented way to
  write a rule — failed against the interface meant to accept it.
- `Action.handle` was typed HTTP-only, so the four actions registered in
  `app/Events.ts` (which the dispatcher calls with a payload) could not
  typecheck. `ActionOptions` now carries a `TInput` generic that defaults
  to the request shape.

Two things the gate caught the moment it started running: `register()`
returns `{ token }`, so `RegisterAction`'s `result.expiresIn` was always
undefined (harmless — `buildAuthCookie` falls back to the configured
expiry — but the intent never worked), and `EvaluateAssertionsAction` was
a plain function wearing an `Action` wrapper it never needed, since
nothing routes to it.

- Annotate the 106 untyped server-block functions as files are touched
  (rule 10: they compile as TypeScript today with every param silently
  `any`); build real ambient types in `types/`.
- Ratchet the tsconfig include one area at a time. `app/lib/**` is in as
  of 2026-08-17; `app/Actions`, `app/Jobs` and the test dirs are the
  remaining steps, largest last.
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
