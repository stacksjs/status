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
  },

  dashboard: {
    highlight: true,
  },
} as const)
