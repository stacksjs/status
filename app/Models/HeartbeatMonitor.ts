import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'HeartbeatMonitor',
  table: 'heartbeat_monitors',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'heartbeat-monitors',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'store', 'show', 'update'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    // Unguessable token the customer's cron job pings — not a numeric FK,
    // so it isn't covered by the mass-assignment `*_id` bypass. Deliberately
    // guarded against normal mass assignment; only RunCheckAction/seeders
    // set it via forceCreate/forceUpdate.
    pingToken: {
      order: 1,
      fillable: true,
      unique: true,
      validation: {
        rule: schema.string().required().max(64),
      },
      factory: () => crypto.randomUUID().replace(/-/g, ''),
    },

    expectedIntervalSeconds: {
      order: 2,
      fillable: true,
      default: 3600,
      validation: {
        rule: schema.number().min(30),
      },
      factory: faker => faker.helpers.arrayElement([300, 3600, 86400]),
    },

    // Optional 5-field cron expression (or @daily-style nickname). When set it
    // drives the next-expected-ping deadline instead of expectedIntervalSeconds
    // — see app/lib/heartbeat.ts. An unparseable expression is fail-safe: the
    // monitor falls back to its interval rather than never alerting.
    cronExpression: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string().max(120),
      },
      factory: () => null,
    },

    graceSeconds: {
      order: 3,
      fillable: true,
      default: 300,
      validation: {
        rule: schema.number().min(0),
      },
      factory: () => 300,
    },

    lastPingAt: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    // When the job last signalled it began, via /ping/{token}/start. Used to
    // measure run duration and to detect an overrun (a start with no matching
    // success within the grace window).
    lastStartedAt: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    // When the job last reported an explicit failure, via /ping/{token}/fail.
    lastFailAt: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    // Duration in seconds of the last completed run (success timestamp minus
    // the preceding /start), or null when the run was not bracketed by a start.
    lastDurationSeconds: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: () => null,
    },
  },
} as const)
