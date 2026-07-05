import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'CheckResult',
  table: 'check_results',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 50,
    },
    useApi: {
      uri: 'check-results',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'show'],
    },
    // Drives the outbound webhook event stream (stacksjs/status#1 Phase 10)
    // — see app/Actions/Webhooks/DeliverCheckResultWebhooks.ts, registered
    // against 'checkresult:created' in app/Events.ts. Fires on every
    // check, not just status transitions — much higher volume than
    // Incident's observe (Phase 6), by design: this is the raw event feed
    // for custom integrations, not a human alert channel.
    observe: ['create'],
  },

  belongsTo: ['Monitor'],

  attributes: {
    status: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.enum(['up', 'down', 'degraded']),
      },
      factory: faker => faker.helpers.arrayElement(['up', 'down', 'degraded']),
    },

    responseTimeMs: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 20, max: 2000 }),
    },

    statusCode: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(599),
      },
      factory: faker => faker.helpers.arrayElement([200, 200, 200, 301, 404, 500, 503]),
    },

    message: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string().max(1000),
      },
      factory: faker => faker.lorem.sentence(),
    },

    // Check-type-specific details (redirect chain, keyword match, cert
    // fingerprint, ...) — JSON string, same convention as Monitor.config.
    metadata: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify({}),
    },

    region: {
      order: 6,
      fillable: true,
      default: 'default',
      validation: {
        rule: schema.string().max(50),
      },
      factory: faker => faker.helpers.arrayElement(['us-east', 'eu-west']),
    },

    checkedAt: {
      order: 7,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
