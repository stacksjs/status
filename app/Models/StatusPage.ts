import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'StatusPage',
  table: 'status_pages',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 5,
    },
    useApi: {
      uri: 'status-pages',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  hasMany: ['StatusPageMonitor'],

  attributes: {
    // Declared explicitly rather than left to a `belongsTo: ['Team']`
    // relation — Team lives in storage/framework/defaults, outside the
    // migration generator's app/Models-only scan (see Monitor.ts).
    teamId: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1, max: 5 }),
    },

    slug: {
      order: 1,
      fillable: true,
      unique: true,
      required: true,
      validation: {
        rule: schema.string().required().max(100),
      },
      factory: faker => faker.helpers.slugify(faker.company.name()).toLowerCase(),
    },

    title: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(150),
      },
      factory: faker => `${faker.company.name()} Status`,
    },

    customDomain: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: () => '',
    },

    // JSON: { logoUrl?, primaryColor? } — same convention as Monitor.config.
    branding: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify({}),
    },

    isPublic: {
      order: 5,
      fillable: true,
      default: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => true,
    },

    // Access control (stacksjs/status#1 Phase 12) — isPublic above still
    // gates whether the page is published at all; accessType gates who
    // can view it once published. 'public' (default) is unchanged
    // behavior; the rest add a gate on top.
    accessType: {
      order: 6,
      fillable: true,
      default: 'public',
      validation: {
        rule: schema.enum(['public', 'password', 'email_domain', 'ip_allowlist']),
      },
      factory: () => 'public',
    },

    // bcrypt/argon2 hash via @stacksjs/security's makeHash — never the
    // plain password. Only meaningful when accessType = 'password'.
    passwordHash: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: () => '',
    },

    // JSON array of allowed email domains (e.g. ["acme.com"]). Only
    // meaningful when accessType = 'email_domain'. Enforcement is a soft
    // gate (see Actions/StatusPages/EmailDomainCheck.ts) — capturing and
    // checking a self-reported email's domain, not verifying ownership of
    // it via a magic link. Documented limitation, not silently insecure.
    authEmailDomains: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([]),
    },

    // JSON array of allowed IPs/CIDR ranges (e.g. ["203.0.113.0/24"]).
    // Only meaningful when accessType = 'ip_allowlist'.
    allowedIpRanges: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([]),
    },

    // BCP-47-ish locale tag (e.g. "en", "de", "fr") for the page's <html
    // lang> attribute (stacksjs/status#1 Phase 12). Full UI string
    // translation (the "Operational"/"Down"/etc. labels) isn't wired —
    // this sets the document's declared language, which is the part that
    // matters for accessibility/SEO even before every label is
    // translated; string translation is a real follow-up, not silently
    // implied by this field.
    locale: {
      order: 10,
      fillable: true,
      default: 'en',
      validation: {
        rule: schema.string().max(10),
      },
      factory: () => 'en',
    },

    // Forces the status page's color scheme regardless of the visitor's
    // OS preference. 'system' (default) leaves it to prefers-color-scheme.
    // Exposed as a `data-theme` attribute on <html> as a hook for CSS —
    // no dark-mode stylesheet variant is shipped yet (a real follow-up,
    // not a silent no-op: the attribute is genuinely there to build on).
    forceTheme: {
      order: 11,
      fillable: true,
      default: 'system',
      validation: {
        rule: schema.enum(['dark', 'light', 'system']),
      },
      factory: () => 'system',
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
