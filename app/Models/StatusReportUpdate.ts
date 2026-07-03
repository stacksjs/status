import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Timeline entries on a StatusReport — same shape as IncidentUpdate.
 */
export default defineModel({
  name: 'StatusReportUpdate',
  table: 'status_report_updates',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 15,
    },
    useApi: {
      uri: 'status-report-updates',
      routes: ['index', 'store', 'show'],
    },

    // Posting an update is what emails status page subscribers about an
    // announcement — see Notifications/SendStatusReportUpdateNotification,
    // registered against 'statusreportupdate:created' in app/Events.ts
    // (model name lowercased with no separator, same convention as
    // 'checkresult:created').
    observe: ['create'],
  },

  belongsTo: ['StatusReport'],

  attributes: {
    message: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(2000),
      },
      factory: faker => faker.lorem.sentence(),
    },

    status: {
      order: 2,
      fillable: true,
      default: 'investigating',
      validation: {
        rule: schema.enum(['investigating', 'identified', 'monitoring', 'resolved']),
      },
      factory: faker => faker.helpers.arrayElement(['investigating', 'identified', 'monitoring', 'resolved']),
    },

    postedAt: {
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
