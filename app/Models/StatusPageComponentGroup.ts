import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Named section a status page groups its monitors into (e.g. "API",
 * "Database", "Dashboard") — stacksjs/status#1 Phase 12, inspired by
 * openstatusHQ/openstatus's page components/component groups (AGPL-3.0 —
 * concept only, independent implementation; this app stays MIT).
 *
 * A monitor with no group (StatusPageMonitor.componentGroupId null)
 * still renders — status pages predate this feature, so grouping is
 * opt-in per status page, not a required migration for every existing
 * one.
 */
export default defineModel({
  name: 'StatusPageComponentGroup',
  table: 'status_page_component_groups',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 8,
    },
    useApi: {
      uri: 'status-page-component-groups',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['StatusPage'],

  attributes: {
    name: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(100),
      },
      factory: faker => faker.commerce.department(),
    },

    displayOrder: {
      order: 2,
      fillable: true,
      default: 0,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 0, max: 20 }),
    },
  },
} as const)
