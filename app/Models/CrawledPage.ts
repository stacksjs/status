import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'CrawledPage',
  table: 'crawled_pages',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 30,
    },
    useApi: {
      uri: 'crawled-pages',
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Crawl'],

  attributes: {
    url: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(2048),
      },
      factory: faker => faker.internet.url(),
    },

    statusCode: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(599),
      },
      factory: faker => faker.helpers.arrayElement([200, 200, 200, 301, 404, 500]),
    },

    foundOnUrl: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().max(2048),
      },
      factory: faker => faker.internet.url(),
    },

    isMixedContent: {
      order: 4,
      fillable: true,
      default: false,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => false,
    },

    isBrokenLink: {
      order: 5,
      fillable: true,
      default: false,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => false,
    },
  },
} as const)
