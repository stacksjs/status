import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Incident',
  table: 'incidents',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 15,
    },
    useApi: {
      uri: 'incidents',
      routes: ['index', 'store', 'show', 'update'],
    },
    useSearch: {
      displayable: ['id', 'status', 'cause', 'startedAt', 'resolvedAt'],
      searchable: ['cause'],
      sortable: ['startedAt', 'resolvedAt'],
      filterable: ['status'],
    },
    observe: true,
  },

  belongsTo: ['Monitor'],
  hasMany: ['IncidentUpdate'],

  attributes: {
    startedAt: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    resolvedAt: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    cause: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().max(500),
      },
      factory: faker => faker.lorem.sentence(),
    },

    status: {
      order: 4,
      fillable: true,
      default: 'investigating',
      validation: {
        rule: schema.enum(['investigating', 'identified', 'monitoring', 'resolved']),
      },
      factory: faker => faker.helpers.arrayElement(['investigating', 'identified', 'monitoring', 'resolved']),
    },

    // Which specific check(s) tripped this incident (e.g. which region,
    // which assertion failed) — JSON string.
    impactedChecks: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([]),
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
