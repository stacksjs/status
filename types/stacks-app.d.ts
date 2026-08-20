/**
 * Local declaration merging for framework types that are missing members the
 * framework implements at runtime.
 *
 * These used to be patched directly into the vendored framework sources
 * (96e18c4, "fix five upstream type gaps"). The framework is an npm dependency
 * now, so editing it in place would be overwritten by the next `bun install`.
 * Declaring the gaps here instead survives upgrades and disappears on its own
 * the day upstream declares them — at which point these become harmless
 * duplicates of an identical signature.
 *
 * Each entry is a *documented runtime behaviour that is simply undeclared*, not
 * a type loosened to silence an error. If a member here ever stops existing at
 * runtime, this file is lying and the fix is to delete the entry, not to widen it.
 */

declare module '@stacksjs/types' {
  interface RequestInstance<TFields extends Record<string, any> = Record<string, any>> {
    /**
     * Single cookie value by name, or `defaultValue` when absent.
     *
     * bun-router's Request implements this (`cookie(name, defaultValue)` in
     * dist/index.js) but never declared it, so callers typechecked as
     * "property does not exist" while working perfectly at runtime — see
     * PasskeyLoginVerifyAction and IncidentFeedAction, which both read their
     * challenge/unlock cookie this way.
     */
    cookie: (name: string, defaultValue?: string) => string | undefined

    /** Raw request body as text; used where a signature is computed over the exact bytes. */
    text: () => Promise<string>
  }
}

export {}
