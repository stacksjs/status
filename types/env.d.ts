/**
 * This app's own environment variables, taught to `@stacksjs/env`.
 *
 * `StacksEnv` is a closed interface shipped by the framework: a fixed list of
 * the keys IT knows about. It carries GOOGLE_CLIENT_ID, but nothing an
 * application declares for itself in config/env.ts extends it, so
 * `env.SSO_OKTA_ISSUER` has no type even though config/env.ts declares the
 * key and the value arrives correctly at runtime (`env` proxies process.env,
 * verified — undeclared keys pass straight through).
 *
 * Until 0.72 that mismatch was invisible: StacksEnv was permissive enough
 * that any key typechecked. The upgrade tightened it, which is how twelve
 * undeclared SSO variables surfaced at once. They are declared in
 * config/env.ts now — that is what gives them validation and a default — and
 * this augmentation is what makes the type agree.
 *
 * Keep the two in step: a key added here without a config/env.ts entry
 * typechecks while going unvalidated, which is the state this file exists to
 * end.
 */

declare module '@stacksjs/env' {
  interface StacksEnv {
    SSO_GOOGLE_CLIENT_ID: string | undefined
    SSO_GOOGLE_CLIENT_SECRET: string | undefined
    SSO_ENTRA_TENANT_ID: string | undefined
    SSO_ENTRA_CLIENT_ID: string | undefined
    SSO_ENTRA_CLIENT_SECRET: string | undefined
    SSO_OKTA_ISSUER: string | undefined
    SSO_OKTA_CLIENT_ID: string | undefined
    SSO_OKTA_CLIENT_SECRET: string | undefined
    SSO_OIDC_ISSUER: string | undefined
    SSO_OIDC_CLIENT_ID: string | undefined
    SSO_OIDC_CLIENT_SECRET: string | undefined
    SSO_OIDC_LABEL: string | undefined
    ANALYTICSHQ_APP_ID: string | undefined
    LOGHQ_KEY: string | undefined
    LOGHQ_HOST: string | undefined
    BUGHQ_KEY: string | undefined
    BUGHQ_HOST: string | undefined
  }
}

export {}
