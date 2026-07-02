import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'SslCertificate',
  table: 'ssl_certificates',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'ssl-certificates',
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    issuer: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: faker => faker.company.name(),
    },

    subject: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: faker => faker.internet.domainName(),
    },

    validFrom: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.past().toISOString(),
    },

    expiresAt: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.future().toISOString(),
    },

    fingerprint: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
      factory: faker => faker.string.hexadecimal({ length: 40 }),
    },

    lastCheckedAt: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
