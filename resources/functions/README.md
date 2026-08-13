# resources/functions

Auto-imported view helpers live here — the framework hoists anything in
this directory into dashboard/server-script scope (see
`storage/framework/core/actions/src/dev/dashboard-globals.ts`), and some
buddy commands scan the directory unconditionally, so it must exist even
while empty.

The starter scaffold that used to sit here (`counter.ts`, `dark.ts`) was
deleted as part of the stx migration (Phase 0 — zero references anywhere;
`dark.ts` predated the app's server-rendered theme approach). When the
client-reactive layer returns (STX-MIGRATION-PLAN.md, Phases 5-6), shared
view helpers belong in this directory.
