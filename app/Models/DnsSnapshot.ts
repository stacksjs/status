import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'DnsSnapshot',
  table: 'dns_snapshots',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'dns-snapshots',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    recordType: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.enum(['A', 'AAAA', 'MX', 'TXT', 'NS', 'CAA', 'CNAME']),
      },
      factory: faker => faker.helpers.arrayElement(['A', 'AAAA', 'MX', 'TXT', 'NS']),
    },

    // JSON-stringified array of record values, same convention as
    // Monitor.config. Named recordValues, not values — `values` is a SQL
    // reserved word and the ORM doesn't quote column names in its INSERT
    // statement, so a literal `values` column breaks every insert.
    recordValues: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([]),
    },

    checkedAt: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
