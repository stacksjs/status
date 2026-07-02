import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'NotificationChannel',
  table: 'notification_channels',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'notification-channels',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['Team'],
  hasMany: ['MonitorNotificationChannel'],

  attributes: {
    // Declared explicitly (rather than left to the `belongsTo: ['Team']`
    // relation above) because Team lives in storage/framework/defaults —
    // the migration generator only loads app/Models, so a relation to a
    // model outside that directory silently produces no FK column at all
    // (see the same workaround on Monitor.ts).
    teamId: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1, max: 5 }),
    },

    name: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(100),
      },
      factory: faker => faker.company.name(),
    },

    type: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.enum([
          'email',
          'sms',
          'slack',
          'discord',
          'teams',
          'pagerduty',
          'opsgenie',
          'pushover',
          'ntfy',
          'webhook',
        ]),
      },
      factory: faker => faker.helpers.arrayElement(['email', 'slack', 'webhook']),
    },

    // Per-type credentials/target, JSON-stringified — same convention as
    // Monitor.config. Shape varies by type: { email } for email,
    // { phone } for sms, { webhookUrl } for slack/discord/teams/ntfy,
    // { routingKey } for pagerduty, { apiKey, teamId } for opsgenie,
    // { userKey, apiToken } for pushover, { url, headers? } for webhook.
    config: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: () => JSON.stringify({}),
    },

    enabled: {
      order: 4,
      fillable: true,
      default: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => true,
    },
  },
} as const)
