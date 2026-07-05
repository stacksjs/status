import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Scheduled, announced downtime (stacksjs/status#1 Phase 12) — distinct
 * from Incident, which is always opened automatically by a failing check.
 * A status page renders an active/upcoming maintenance window as its own
 * banner rather than as an outage, so planned work doesn't read as an
 * incident to visitors.
 *
 * `status` is kept in sync with `startsAt`/`endsAt` by the
 * UpdateMaintenanceWindowStatus scheduled job rather than computed at
 * render time — status pages query "what's active right now" a lot more
 * often than a window's status actually changes, so precomputing is
 * cheaper than every status-page render doing its own now-vs-timestamp
 * comparison across every window.
 */
export default defineModel({
  name: 'MaintenanceWindow',
  table: 'maintenance_windows',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 6,
    },
    useApi: {
      uri: 'maintenance-windows',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  attributes: {
    // Declared explicitly rather than left to a `belongsTo: ['Team']`
    // relation — Team lives in storage/framework/defaults, outside the
    // migration generator's app/Models-only scan (same workaround as
    // Monitor.ts, StatusPage.ts, ...).
    teamId: {
      order: 0,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1, max: 5 }),
    },

    title: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(150),
      },
      factory: faker => `Scheduled maintenance: ${faker.company.buzzPhrase()}`,
    },

    description: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(2000),
      },
      factory: faker => faker.lorem.paragraph(),
    },

    startsAt: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.soon().toISOString(),
    },

    endsAt: {
      order: 4,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.soon({ days: 2 }).toISOString(),
    },

    status: {
      order: 5,
      fillable: true,
      default: 'scheduled',
      validation: {
        rule: schema.enum(['scheduled', 'active', 'completed', 'cancelled']),
      },
      factory: faker => faker.helpers.arrayElement(['scheduled', 'active', 'completed', 'cancelled']),
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
