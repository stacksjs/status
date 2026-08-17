# resources/components

stx components live here. `config/ui.ts` pins `componentsDir` to this path, and
the stx loader resolves it at boot — so the directory must exist even while
empty, or `buddy dev` prints:

    [stx] componentsDir resolves to ".../resources/components", which does not
    exist. Configured as "resources/components".

The pin is deliberate rather than incidental: before it, the two loaders
inferred different roots and disagreed (STX-MIGRATION-PLAN.md, Phase 0). The
fix is to keep the pin and keep the directory, not to drop the config back to
inference.

The starter scaffold that used to sit here — 13 unreferenced demo components
from the Stacks template — was deleted in Phase 0. Real components arrive in
Phase 6, which is gated on the stx upgrade and the `:for` hydration question;
see the plan.
