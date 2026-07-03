import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A developer-registered outbound webhook: POSTs every check result for a
 * team's monitors to a URL the team controls. Distinct from
 * NotificationChannel's webhook type (Phase 6) — that fires on incident
 * open/resolve only, formatted as a human-readable alert; this fires on
 * every single check result, formatted as a raw event payload, for
 * building custom integrations/dashboards on top of this product's data.
 */
export default defineModel({
  name: 'WebhookSubscription',
  table: 'webhook_subscriptions',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'webhook-subscriptions',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

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

    url: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(2048),
      },
      factory: faker => faker.internet.url(),
    },

    // Shared secret used to sign the payload (HMAC-SHA256 in the
    // X-Webhook-Signature header) so the receiver can verify authenticity.
    secret: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(255),
      },
      factory: () => crypto.randomUUID(),
    },

    enabled: {
      order: 3,
      fillable: true,
      default: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => true,
    },
  },
} as const)
