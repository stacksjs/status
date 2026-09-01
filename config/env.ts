import type { EnvConfig } from '@stacksjs/env'
import { schema } from '@stacksjs/validation'

/**
 * **Env Configuration & Validations**
 *
 * This configuration defines all of your Env validations. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  APP_NAME: {
    validation: schema.string(),
    default: 'Stacks',
  },

  APP_ENV: {
    validation: schema.enum(['local', 'dev', 'stage', 'prod']),
    default: 'local',
  },

  APP_KEY: {
    validation: schema.string(),
    default: 'base64:1234567890',
  },

  PORT: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_BACKEND: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_ADMIN: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_LIBRARY: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_DESKTOP: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_EMAIL: {
    validation: schema.number(),
    default: 3000,
  },
  PORT_DOCS: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_INSPECT: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_API: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_SYSTEM_TRAY: {
    validation: schema.number(),
    default: 3000,
  },

  APP_MAINTENANCE: {
    validation: schema.boolean(),
    default: false,
  },

  APP_MAINTENANCE_SECRET: {
    validation: schema.string(),
    default: '',
  },

  APP_COMING_SOON: {
    validation: schema.boolean(),
    default: false,
  },

  APP_COMING_SOON_SECRET: {
    validation: schema.string(),
    default: '',
  },

  DEBUG: {
    validation: schema.boolean(),
    default: false,
  },

  API_PREFIX: {
    validation: schema.string(),
    default: '/api',
  },

  DOCS_PREFIX: {
    validation: schema.string(),
    default: '/docs',
  },

  DB_CONNECTION: {
    validation: schema.enum(['mysql', 'sqlite', 'postgres']),
    default: 'mysql',
  },

  DB_HOST: {
    validation: schema.string(),
    default: 'localhost',
  },

  DB_PORT: {
    validation: schema.number(),
    default: 3306,
  },

  AWS_ACCOUNT_ID: {
    validation: schema.string(),
    default: '',
  },

  AWS_ACCESS_KEY_ID: {
    validation: schema.string(),
    default: '',
  },

  AWS_SECRET_ACCESS_KEY: {
    validation: schema.string(),
    default: '',
  },

  AWS_DEFAULT_REGION: {
    validation: schema.string(),
    default: '',
  },

  AWS_DEFAULT_PASSWORD: {
    validation: schema.string(),
    default: '',
  },

  MAIL_MAILER: {
    validation: schema.enum(['ses', 'sendgrid', 'mailgun', 'mailtrap', 'smtp', 'postmark', 'sendmail', 'log']),
    default: 'ses',
  },

  MAIL_HOST: {
    validation: schema.string(),
    default: '',
  },

  MAIL_PORT: {
    validation: schema.number(),
    default: 465,
  },

  MAIL_USERNAME: {
    validation: schema.string(),
    default: '',
  },

  MAIL_PASSWORD: {
    validation: schema.string(),
    default: '',
  },

  MAIL_FROM_ADDRESS: {
    validation: schema.string(),
    default: '',
  },

  SEARCH_ENGINE_DRIVER: {
    validation: schema.enum(['meilisearch', 'algolia', 'typesense']),
    default: 'meilisearch',
  },

  STRIPE_SECRET_KEY: {
    validation: schema.string(),
    default: '',
  },

  STRIPE_PUBLISHABLE_KEY: {
    validation: schema.string(),
    default: '',
  },

  // Signing secret for verifying inbound Stripe webhook requests
  // (`whsec_...`, from the Stripe dashboard's webhook endpoint config).
  STRIPE_WEBHOOK_SECRET: {
    validation: schema.string(),
    default: '',
  },

  // Optional: a pre-created Stripe recurring Price ID for the $9/mo
  // paid plan (stacksjs/status#1 Phase 9). When unset,
  // CreateCheckoutSessionAction falls back to inline `price_data` so
  // checkout works immediately with nothing more than
  // STRIPE_SECRET_KEY — see config/plans.ts's PLAN_STRIPE_PRICE_ID.
  STRIPE_PRICE_PRO: {
    validation: schema.string(),
    default: '',
  },

  MEILISEARCH_HOST: {
    validation: schema.string(),
    default: '',
  },

  MEILISEARCH_KEY: {
    validation: schema.string(),
    default: '',
  },

  FRONTEND_APP_ENV: {
    validation: schema.enum(['development', 'staging', 'production']),
    default: 'development',
  },

  FRONTEND_APP_URL: {
    validation: schema.string(),
    default: '',
  },

  // Single sign-on credentials, read by config/sso.ts.
  //
  // These were used without ever being declared here. StacksEnv used to be
  // permissive enough that `env.SSO_OKTA_ISSUER` typechecked against nothing,
  // so the keys worked by accident and were never validated, defaulted or
  // documented — the framework upgrade that tightened StacksEnv is what
  // surfaced them. Declaring them is the fix, not casting the reads away:
  // an SSO provider is configured or it is not, and an empty default is what
  // config/sso.ts already treats as "this provider is off".
  //
  // Google and Entra also answer to the unprefixed GOOGLE_CLIENT_ID /
  // GOOGLE_CLIENT_SECRET the framework declares; config/sso.ts prefers those
  // and falls back to these.
  SSO_GOOGLE_CLIENT_ID: { validation: schema.string(), default: '' },
  SSO_GOOGLE_CLIENT_SECRET: { validation: schema.string(), default: '' },
  SSO_ENTRA_TENANT_ID: { validation: schema.string(), default: '' },
  SSO_ENTRA_CLIENT_ID: { validation: schema.string(), default: '' },
  SSO_ENTRA_CLIENT_SECRET: { validation: schema.string(), default: '' },
  SSO_OKTA_ISSUER: { validation: schema.string(), default: '' },
  SSO_OKTA_CLIENT_ID: { validation: schema.string(), default: '' },
  SSO_OKTA_CLIENT_SECRET: { validation: schema.string(), default: '' },
  SSO_OIDC_ISSUER: { validation: schema.string(), default: '' },
  SSO_OIDC_CLIENT_ID: { validation: schema.string(), default: '' },
  SSO_OIDC_CLIENT_SECRET: { validation: schema.string(), default: '' },
  SSO_OIDC_LABEL: { validation: schema.string(), default: '' },

  // Streams this app's logs to loghq. Empty disables the transport rather than
  // failing: the client reports "no ingest key, client disabled" and every
  // log.* call carries on writing to the console and the log file as before.
  // Declared in types/env.d.ts too — a key in one place but not the other
  // typechecks while going unvalidated, which is what that file exists to end.
  LOGHQ_KEY: { validation: schema.string(), default: '' },
  // Reports this app's own errors to bughq. Empty disables capture rather than
  // failing: the client marks itself disabled on construction, silently.
  BUGHQ_KEY: {
    validation: schema.string(),
    default: '',
  },

  // Override only to point at a bughq other than the hosted one. Empty means
  // the SDK's own default host.
  BUGHQ_HOST: {
    validation: schema.string(),
    default: '',
  },

  // Override only to point at a loghq other than the hosted one, e.g. a local
  // dev server. Empty means the SDK's own default host.
  LOGHQ_HOST: { validation: schema.string(), default: '' },
} satisfies EnvConfig
