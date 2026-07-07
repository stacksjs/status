import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A visitor who asked to be emailed about incidents on one specific status
 * page. Deliberately its own model rather than reusing the built-in
 * Subscriber/EmailList (those model marketing-campaign subscribers with a
 * belongsTo: ['User'] and campaign-send history) — a status-page watcher is
 * an anonymous email address tied to one status page, not a user account.
 */
export default defineModel({
  name: 'StatusPageSubscriber',
  table: 'status_page_subscribers',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'status-page-subscribers',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'destroy'],
    },
  },

  belongsTo: ['StatusPage'],

  attributes: {
    email: {
      order: 1,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().email().max(255),
      },
      factory: faker => faker.internet.email(),
    },

    // Unguessable token for the one-click unsubscribe link in every email —
    // same convention as HeartbeatMonitor.pingToken.
    unsubscribeToken: {
      order: 2,
      fillable: true,
      required: true,
      // Bearer capability for the one-click unsubscribe link — exposing it
      // lets anyone unsubscribe arbitrary subscribers, so keep it hidden.
      hidden: true,
      validation: {
        rule: schema.string().required().max(64),
      },
      factory: () => crypto.randomUUID().replace(/-/g, ''),
    },

    confirmedAt: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
