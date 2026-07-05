import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Crawl',
  table: 'crawls',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'crawls',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Monitor'],
  hasMany: ['CrawledPage'],

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

    finishedAt: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    pagesCrawled: {
      order: 3,
      fillable: true,
      default: 0,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 1, max: 200 }),
    },

    brokenLinksCount: {
      order: 4,
      fillable: true,
      default: 0,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 0, max: 20 }),
    },

    mixedContentCount: {
      order: 5,
      fillable: true,
      default: 0,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 0, max: 5 }),
    },

    status: {
      order: 6,
      fillable: true,
      default: 'running',
      validation: {
        rule: schema.enum(['running', 'completed', 'failed']),
      },
      factory: faker => faker.helpers.arrayElement(['running', 'completed', 'failed']),
    },
  },
} as const)
