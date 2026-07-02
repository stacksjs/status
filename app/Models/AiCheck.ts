import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'AiCheck',
  table: 'ai_checks',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'ai-checks',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    // Plain-English description of what to verify, e.g. "the pricing page
    // shows a 'Buy now' button and no error text".
    prompt: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(1000),
      },
      factory: faker => `the page shows ${faker.commerce.productName()} and no error text`,
    },

    lastResult: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(2000),
      },
      factory: faker => faker.lorem.sentence(),
    },

    lastPassed: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: faker => faker.datatype.boolean(),
    },

    lastCheckedAt: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
