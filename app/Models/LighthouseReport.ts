import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'LighthouseReport',
  table: 'lighthouse_reports',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'lighthouse-reports',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    performanceScore: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.int({ min: 40, max: 100 }),
    },

    accessibilityScore: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.int({ min: 40, max: 100 }),
    },

    seoScore: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.int({ min: 40, max: 100 }),
    },

    bestPracticesScore: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.int({ min: 40, max: 100 }),
    },

    // Full Lighthouse JSON report, JSON-stringified — same convention as
    // Monitor.config. Kept for drill-down (which audits failed, opportunity
    // details); the four scores above drive alerting on their own.
    reportJson: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify({}),
    },

    checkedAt: {
      order: 6,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
