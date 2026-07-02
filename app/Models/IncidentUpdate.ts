import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'IncidentUpdate',
  table: 'incident_updates',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 30,
    },
    useApi: {
      uri: 'incident-updates',
      routes: ['index', 'store', 'show'],
    },
  },

  // `User` is nullable — system-posted updates (e.g. auto-resolved by a
  // recovering check) have no author.
  belongsTo: ['Incident', 'User'],

  attributes: {
    // Declared explicitly rather than left to the `belongsTo: [..., 'User']`
    // relation above — User lives in storage/framework/defaults, which the
    // migration generator (unlike runtime relation resolution) never loads,
    // so it wouldn't otherwise produce a user_id column. Nullable: system-
    // posted updates (e.g. an auto-resolved incident) have no author.
    userId: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1, max: 5 }),
    },

    message: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(2000),
      },
      factory: faker => faker.lorem.paragraph(),
    },

    status: {
      order: 2,
      fillable: true,
      required: true,
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
