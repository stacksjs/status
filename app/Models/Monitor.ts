import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'Monitor',
  table: 'monitors',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 10,
    },
    useApi: {
      uri: 'monitors',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      middleware: ['auth'],
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
    useSearch: {
      displayable: ['id', 'name', 'url', 'type', 'status', 'enabled', 'lastCheckedAt'],
      searchable: ['name', 'url'],
      sortable: ['name', 'lastCheckedAt', 'createdAt'],
      filterable: ['type', 'status', 'enabled'],
    },
    observe: true,
  },

  belongsTo: ['Team'],
  hasMany: ['CheckResult', 'Incident'],

  attributes: {
    // Declared explicitly (rather than left to the `belongsTo: ['Team']`
    // relation below) because Team lives in storage/framework/defaults —
    // the migration generator only loads app/Models, so a relation to a
    // model outside that directory silently produces no FK column at all.
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
        rule: schema.string().required().max(150),
      },
      factory: faker => faker.company.name(),
    },

    url: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required().max(2048),
      },
      factory: faker => faker.internet.url(),
    },

    type: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.enum([
          'uptime',
          'ssl',
          'broken_links',
          'performance',
          'lighthouse',
          'domain',
          'dns',
          'health',
          'cron',
          'ping',
          'tcp_port',
          'port_scan',
          'dns_blocklist',
          'ai_check',
        ]),
      },
      factory: faker => faker.helpers.arrayElement(['uptime', 'ssl', 'ping', 'dns']),
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

    checkIntervalSeconds: {
      order: 5,
      fillable: true,
      default: 60,
      validation: {
        rule: schema.number().min(10),
      },
      factory: faker => faker.helpers.arrayElement([30, 60, 300, 900]),
    },

    // Per-type check settings (expected status codes, keyword assertions,
    // crawl depth, port lists, ...). Stored as a JSON string, same
    // convention as Product.allergens/nutritionalInfo.
    config: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify({}),
    },

    status: {
      order: 7,
      fillable: true,
      default: 'unknown',
      validation: {
        rule: schema.enum(['up', 'down', 'degraded', 'paused', 'unknown']),
      },
      factory: faker => faker.helpers.arrayElement(['up', 'down', 'degraded', 'unknown']),
    },

    lastCheckedAt: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },

    // Consecutive failed checks, reset to 0 on any 'up' result. Drives
    // exponential backoff in DispatchDueChecks (stacksjs/status#1
    // Phase 11) so a monitor stuck down doesn't get hammered at its normal
    // interval forever — a site returning 500s every 30s for a week is 20k
    // wasted requests against a host that's already struggling.
    consecutiveFailures: {
      order: 9,
      fillable: true,
      default: 0,
      validation: {
        rule: schema.number().min(0),
      },
      factory: () => 0,
    },

    // Whether this monitor accepts pushed CPU/RAM samples from the
    // customer's own server via POST /agent/{metricsToken}/metrics.
    // Orthogonal to `type` (an uptime/ssl/ping/... monitor can also report
    // metrics) rather than a new `type` value, so enabling it never touches
    // the `type` CHECK constraint (which would force a destructive SQLite
    // table rebuild on this live app).
    reportsMetrics: {
      order: 10,
      fillable: true,
      default: false,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => false,
    },

    // Unguessable token that IS the auth for the metrics-push endpoint —
    // same convention as HeartbeatMonitor.pingToken. Nullable: only
    // monitors with reportsMetrics enabled have one.
    metricsToken: {
      order: 11,
      fillable: true,
      validation: {
        rule: schema.string().max(64),
      },
      factory: () => crypto.randomUUID().replace(/-/g, ''),
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
