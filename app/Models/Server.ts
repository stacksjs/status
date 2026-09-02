import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One physical (or virtual) box. Owns the agent ingest token, the
 * CPU/memory/disk alert thresholds, the missed-push window, the host metric
 * history (ServerMetricSample) and the two server-level incidents: "box is
 * hot" (a threshold breach, routed as an issue) and "agent went quiet" (no
 * push inside the window).
 *
 * A Monitor sits on at most one Server (monitors.server_id, nullable) and a
 * Server carries any number of monitors. The monitor keeps everything about
 * the site — url, check type, assertions, up/down, uptime, the "site is down"
 * incident. Nothing on this model or in its jobs writes monitors.status or
 * monitors.last_checked_at.
 *
 * Not called Host: `host` already means the free-text machine label an agent
 * sends with each sample (ServerMetricSample.host, normalizeHost) and the
 * hostname siteHost() derives from a monitor URL. A third meaning would be
 * one too many.
 */
export default defineModel({
  name: 'Server',
  table: 'servers',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSeeder: {
      count: 5,
    },
    useApi: {
      uri: 'servers',
      // Auto-CRUD reads are public by default (auto-crud.ts resolveApiMiddleware);
      // this tenant data must never be world-readable, so require auth on every route.
      // Reads only: metricsToken is hidden:true, so the auto-CRUD store would
      // strip the one credential a server needs, and status/lastSampleAt are
      // owned by the ingest path. Writes go through dedicated actions.
      middleware: ['auth'],
      routes: ['index', 'show'],
    },
    useSearch: {
      displayable: ['id', 'name', 'status', 'lastSampleAt'],
      searchable: ['name'],
      sortable: ['name', 'lastSampleAt', 'createdAt'],
      filterable: ['status'],
    },
  },

  hasMany: ['Monitor', 'ServerMetricSample', 'Incident'],

  attributes: {
    // Owning team, declared explicitly like every tenant-owned model in app/Models.
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
      factory: faker => faker.internet.domainName(),
    },

    // Unguessable token that IS the auth for the agent metrics-push endpoint —
    // same convention as HeartbeatMonitor.pingToken. An agent installed
    // against a monitor's metrics_token keeps working once that value is
    // carried over here verbatim.
    metricsToken: {
      order: 2,
      fillable: true,
      unique: true,
      // Anyone who can read it can inject fake samples, so it must never
      // serialize into an API response (same reasoning as User.password's
      // hidden flag). hidden:true also strips it from auto-CRUD write bodies,
      // so it is only ever minted server-side.
      hidden: true,
      validation: {
        rule: schema.string().max(64),
      },
      factory: () => crypto.randomUUID().replace(/-/g, ''),
    },

    // Alert when CPU% >= this. 0 disables CPU alerting.
    cpuThreshold: {
      order: 3,
      fillable: true,
      default: 90,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: () => 90,
    },

    // Alert when memory% >= this. 0 disables.
    ramThreshold: {
      order: 4,
      fillable: true,
      default: 90,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: () => 90,
    },

    // Alert when disk% >= this, only when the agent reports disk. 0 disables.
    diskThreshold: {
      order: 5,
      fillable: true,
      default: 85,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: () => 85,
    },

    // One value, two jobs, on purpose: the freshness cutoff for the per-host
    // fleet verdict at ingest AND the missed-push deadline for the stale-server
    // sweep. Splitting them lets a box be permanently "hot" from a host that
    // stopped reporting, or permanently silent-but-green.
    metricsWindowSeconds: {
      order: 6,
      fillable: true,
      default: 300,
      validation: {
        rule: schema.number().min(30).max(86400),
      },
      factory: () => 300,
    },

    // 'healthy' every fresh host is within thresholds; 'hot' at least one
    // fresh host is breaching (reachable, busy); 'quiet' the agent went
    // silent (no push inside the window); 'unknown' never received a sample.
    // Not fillable: written only by the ingest path and the stale-server job,
    // never from a request body.
    status: {
      order: 7,
      fillable: false,
      default: 'unknown',
      validation: {
        rule: schema.enum(['healthy', 'hot', 'quiet', 'unknown']),
      },
      factory: faker => faker.helpers.arrayElement(['unknown', 'healthy', 'hot']),
    },

    // Denormalised newest sampled_at across every host on this box. The
    // missed-push baseline and the "last sample 42s ago" readouts come from
    // here rather than a MAX() over the samples table on every tick and page.
    // Not fillable for the same reason as status.
    lastSampleAt: {
      order: 8,
      fillable: false,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },
  },

  dashboard: {
    highlight: true,
  },
} as const)
