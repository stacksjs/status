import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Lightweight organization/filtering label for monitors (e.g. "prod",
 * "critical", "backend") — stacksjs/status#1 Phase 12.
 */
export default defineModel({
  name: 'MonitorTag',
  table: 'monitor_tags',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'monitor-tags',
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

    name: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(50),
      },
      factory: faker => faker.helpers.arrayElement(['prod', 'staging', 'critical', 'backend', 'frontend', 'internal']),
    },

    // Hex color for the tag chip (e.g. "#EF4444") — optional, a sensible
    // default color can be assigned client-side when unset.
    color: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(20),
      },
      factory: faker => faker.color.rgb(),
    },
  },
} as const)
