# resources/stores

Client-side stores live here. `config/ui.ts` pins `storesDir` to this path and
the store loader resolves `path.resolve(root, storesDir)` at boot, so the
directory must exist even while empty — same reason as
`resources/components/README.md`.

Nothing lives here yet by design: this app is server-rendered with plain
scripts, a decision documented in
`resources/views/dashboard/monitors/index.stx`'s header (the unresolved
`:for expected an array` hydration warning). A real store is Phase 6 work and
is gated on re-testing that on the upgraded stx — see STX-MIGRATION-PLAN.md.
