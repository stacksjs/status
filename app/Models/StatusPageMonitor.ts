import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Pivot: which monitors a status page shows, under what display name and
 * order — a status page shows curated, renamed monitors rather than raw
 * internal monitor names/URLs (a customer shouldn't see "prod-db-tcp-5432",
 * they should see "Database").
 */
export default defineModel({
  name: 'StatusPageMonitor',
  table: 'status_page_monitors',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['StatusPage', 'Monitor'],

  attributes: {
    displayName: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().max(150),
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
