import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * Team membership + invites (stacksjs/status#1 Phase 9). The built-in
 * Team/User models (storage/framework/defaults) have no membership
 * relation between them at all — this is the missing pivot, plus the
 * `role`/`status` fields Oh Dear-style team invites need (owner/admin/
 * member; pending until accepted).
 *
 * `userId` is nullable: an invite is created by email before the invitee
 * necessarily has an account. `AcceptTeamInviteAction` fills it in and
 * flips `status` to 'active' once the invite is accepted.
 */
export default defineModel({
  name: 'TeamMember',
  table: 'team_members',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'team-members',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'show', 'destroy'],
    },
  },

  attributes: {
    // Declared explicitly rather than left to a `belongsTo: ['Team']`
    // relation — Team lives in storage/framework/defaults, outside the
    // migration generator's app/Models-only scan (same workaround as
    // Monitor.ts, StatusPage.ts, ...).
    teamId: {
      order: 0,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1, max: 5 }),
    },

    // Nullable until the invite is accepted — see class doc comment above.
    userId: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: faker => faker.number.int({ min: 1, max: 20 }),
    },

    invitedEmail: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(255),
      },
      factory: faker => faker.internet.email(),
    },

    role: {
      order: 3,
      fillable: true,
      default: 'member',
      validation: {
        rule: schema.enum(['owner', 'admin', 'member']),
      },
      factory: faker => faker.helpers.arrayElement(['owner', 'admin', 'member']),
    },

    status: {
      order: 4,
      fillable: true,
      default: 'pending',
      validation: {
        rule: schema.enum(['pending', 'active']),
      },
      factory: faker => faker.helpers.arrayElement(['pending', 'active']),
    },

    invitedAt: {
      order: 5,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    joinedAt: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
