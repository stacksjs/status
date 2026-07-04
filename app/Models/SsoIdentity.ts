import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Links a local user to an identity at an OIDC provider. The (provider,
 * subject) pair is the stable key an IdP promises never to reuse; email
 * is stored as a courtesy copy for the dashboard, never for lookups
 * after the first link (people change addresses, subjects don't).
 * See app/Actions/Auth/SsoCallbackAction.ts for the linking rules.
 */
export default defineModel({
  name: 'SsoIdentity',
  table: 'sso_identities',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['User'],

  attributes: {
    provider: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().max(50),
      },
    },

    subject: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
    },

    email: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().max(255),
      },
    },
  },
} as const)
