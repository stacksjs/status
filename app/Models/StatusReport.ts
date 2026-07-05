import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A manually-authored status page announcement — distinct from Incident,
 * which is always opened automatically by a failing check (stacksjs/
 * status#1 Phase 12, inspired by openstatusHQ/openstatus's status
 * reports — AGPL-3.0, concept only, independent implementation; this
 * app stays MIT).
 *
 * Same status vocabulary as Incident (investigating/identified/
 * monitoring/resolved) so the status page can reuse the same badge/tone
 * styling for both — but nothing in this app ever creates a StatusReport
 * automatically; it's always a human via the dashboard/API, e.g. "we're
 * migrating databases this weekend."
 */
export default defineModel({
  name: 'StatusReport',
  table: 'status_reports',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 8,
    },
    useApi: {
      uri: 'status-reports',
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
    // Monitor.ts, MaintenanceWindow.ts, ...).
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
      factory: faker => faker.company.buzzPhrase(),
    },

    body: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(2000),
      },
      factory: faker => faker.lorem.paragraph(),
    },

    status: {
      order: 3,
      fillable: true,
      default: 'investigating',
      validation: {
        rule: schema.enum(['investigating', 'identified', 'monitoring', 'resolved']),
      },
      factory: faker => faker.helpers.arrayElement(['investigating', 'identified', 'monitoring', 'resolved']),
    },

    startedAt: {
      order: 4,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    resolvedAt: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
