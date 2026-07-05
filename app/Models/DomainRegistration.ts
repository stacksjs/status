import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'DomainRegistration',
  table: 'domain_registrations',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'domain-registrations',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    registrar: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: faker => faker.company.name(),
    },

    registeredAt: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.past().toISOString(),
    },

    expiresAt: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.future().toISOString(),
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
