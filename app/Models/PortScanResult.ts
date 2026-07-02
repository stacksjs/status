import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'PortScanResult',
  table: 'port_scan_results',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'port-scan-results',
      routes: ['index', 'show'],
    },
  },

  belongsTo: ['Monitor'],

  attributes: {
    // JSON array of open port numbers found — same convention as
    // Monitor.config.
    openPorts: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([22, 80, 443]),
    },

    // JSON array the monitor is configured to expect (Monitor.config.ports),
    // so a diff can flag "expected port went down" separately from
    // "unexpected port appeared".
    expectedPorts: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([80, 443]),
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
