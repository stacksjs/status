# Server model — implementation spec (revision 3)

Target: the `status` app in this repository. Framework: Stacks (`@stacksjs/database@0.74.0`), SQLite 3.51.0 in dev and prod, hand-written append-only migrations, next migration number `0000000281`. The design decisions this spec implements are recorded in `SERVER-MODEL-PLAN.md`; where an earlier draft of this spec disagreed with that document, the plan wins and §0 records the delta.

Settled design (not re-opened here): a `Server` is one physical box with one identity. It owns the agent token, the CPU/RAM/disk thresholds, the missed-push window, the host metric history, its own status (`healthy` / `hot` / `quiet` / `unknown`) and the two server-level incidents ("box is hot", "agent went quiet"). A `Monitor` keeps url, check type, interval, assertions, up/down, uptime %, and the "site is down" incident. `monitors.server_id` is nullable; a monitor with no server behaves exactly as today. `reports_metrics` disappears: "does this report metrics" is "is `server_id` set". Storage decision (panel 2–1): samples live in a **separate table**, `server_metric_samples`, never in `check_results`.

---

## 0. What changed in this revision

A reader of the previous drafts should expect these deltas. Everything else is carried over.

1. **Status vocabulary is `healthy` / `hot` / `quiet` / `unknown`** (the plan's words), not `up` / `degraded` / `down`. `unknown` means "never received a sample". Applied to `Server.ts`, the `servers.status` CHECK constraint, the ingest, `CheckStaleServers`, the pills, and every test. Per-host *reading* verdicts inside `agentHosts.ts` (`HostReading.status`, `HostAggregate.status`, the ingest response's `sampleStatus`) keep `up` / `degraded`: those describe a sample, not the box.
2. **Backfill population follows the plan's rules 1–4 exactly.** One server per distinct `monitors.metrics_token` that has at least one `check_results` row with `region = 'agent'`; a token with no samples gets no server, its monitors keep `server_id = NULL` and the orphan token is dropped; thresholds come from `config` JSON with defaults; every currently-open incident whose `impacted_checks` contains `type: 'server_metrics'` is resolved by the command with an `IncidentUpdate`. Nothing in the backfill reads `reports_metrics` or mints a token. Incident history is not moved; it stays on the monitor it was opened on. Production counts are the plan's (read-only, 2026-09-02): 45 open "host threshold breached" incidents and 5 open "agent went quiet" incidents (the four never-installed tokens plus one monitor whose flag is off but whose token still exists). The previous draft's "five on one monitor plus one each on two others" was a partial tally of the same set and is dropped; the plan's numbers are the ones this spec carries.
3. **Both server incidents route as `issue`.** "Box is hot" (`server_hot`) and "agent went quiet" (`server_silent`) are issues, never `down`; a server never pages as an outage, only a site's own monitor does. This preserves what production does today (`CheckStaleMetrics` writes `type: 'server_metrics'`, which classifies as issue) and matches the plan's "a threshold breach is an issue, not a down". The `notification-severity-routing` test whose fixture used `type: 'missed_push'` (a shape nothing in the app writes) is fixed to use the real marker and assert `issue`. Flip-able; see §9.2.
4. **Incident lifecycle is reconciled from state, never from an edge, on every ingest AND every `CheckStaleServers` tick** — the pattern `EvaluateMonitorConsensus.ts:141-171` already uses. The previous draft's tick passed no fleet, so its hot branch returned early and a tick could never open a `server_hot` for a server whose status was `hot` with nothing open (a crash between the status write and the reconcile, or the post-backfill state from phase A). Now the tick recomputes the fleet from `server_metric_samples` with the same windowed query the ingest uses (§4.3), so `healthy` resolves any open `server_hot` and `server_silent`; `hot` opens one `server_hot` if none is open and otherwise updates it in place (cause and marker, plus an `IncidentUpdate`) when the breach set changes; `quiet` opens one `server_silent` if none is open — on both paths. Dedup is by marker kind, never by cause string (the cause embeds live percentages, so cause-dedup never matched across ticks — the reason one production monitor alone holds five open breach incidents). At most one open incident of each kind per server. The quiet detector skips `status = 'unknown'`: never-heard-from is not went-quiet, so a freshly created server does not page five minutes after creation.
5. **`useApi.routes` for `Server` is `['index', 'show']`.** `update` and `destroy` go through team-scoped dashboard actions only. `status` and `lastSampleAt` are not fillable; the three writers (`ReceiveMetricsAction`, `CheckStaleServers`, the backfill) write them through the query builder. Delete nulls `monitors.server_id`, deletes samples and resolves open server incidents in one transaction.
6. **Ship mechanics** from the migration-risk review: the backfill moves rows in id-range batches; the order is additive migrations + indexes → deploy new code → backfill → backfill again with `--final`; `servers.last_sample_at` is set from `MAX(checked_at)` over **all** legacy agent rows (metric-less ones included) in the same transaction that attaches the monitors, before any source row is deleted and before `CheckStaleServers` can see the server; the `sampled_at` index and `PruneOldServerMetricSamples` (own retention env var) ship with the table. **Row-count assertion, stated precisely:** every batch asserts `inserted == convertible` and `convertible + metricless == read` before it deletes source rows. That is a deliberate deviation from the literal "samples inserted == agent rows read": legacy agent rows with no numeric `cpuPercent`/`ramPercent` cannot be inserted into a table whose percent columns are `NOT NULL` (0000000282), so they are counted and dropped, not inserted — their only useful content, the timestamp, already survived into `last_sample_at` in phase A. No source row is deleted unaccounted for. The alternative (nullable percent columns so the literal equality holds) was rejected: it would put rows with no reading into a table every reader treats as readings.
7. **Claims corrected against the code:** `metrics-consensus-ownership.test.ts` never invokes `CheckStaleMetrics` (no fixture change needed); `monitor-form-wiring.test.ts` has no threshold wiring (only `tests/unit/monitor-form.test.ts:174-178` does); `incidentPillClass` is local to `monitors/[id].stx`, not in `display.ts` (it is lifted there); `numberOrNull` in `agentHosts.ts` is module-private (exported); the live `incidents` schema is `0000000118`, not `0000000215`; `tests/unit/uptime.test.ts` has no agent-row case (the invariant is pinned by a feature test instead); `agent-snippet.test.ts:110`'s regex is retargeted to `__serverRow.metrics_token`; the docs and marketing edits are scoped to every paragraph that becomes false. **New in this revision:** the transaction API is named correctly (§0.11); `.env.example` has no `CHECK_RESULT_RETENTION_DAYS` line, so §4.4 adds both variables (§0.16); the "93,864 of 96,350 incidents" figure that `EvaluateMonitorConsensus.ts:23`, `tests/feature/server-metrics.test.ts:107` and `metrics-consensus-ownership.test.ts:24` carry describes an earlier state of the production database than the plan's all-time table (roughly 3,800 incidents on 2026-09-02) and is not repeated anywhere in this spec.
8. **Silent assumptions written down:** the live-view nudges are removed (they were a no-op single-instance, and on Redis they broadcast an unchanged monitor status); server incidents do not appear in uptime report emails (release note); `notifyServerIncident` filters the fan-out monitors by the server's `team_id` — which is a guard against a monitor pointed at a foreign box, **not** against a forged incident (§0.10 is the guard for that).
9. **Publishable:** repo-relative paths only, no addresses, hostnames, tenant names or local row ids. Monitor ids are fine.
10. **`POST /api/incidents` and `PATCH /api/incidents/{id}` are overridden with team-checked actions** (§4.9). The previous draft's claim that the server notification branch "does not widen" the pre-existing hole was wrong: `Incident` has no `team_id`, its generated store has no team stamp, and `observe: true` fires `incident:created` on every store — so `POST /api/incidents { server_id: <another team's server>, cause: <anything> }` would have reached `notifyServerIncident`, whose team filter selects the *victim* team's channels, and paged them with attacker text. The generated update was the same hole one step later (PATCH a foreign `server_id` + `status: 'resolved'` → the resolved listener). Both routes now go through `Actions/Incidents/CreateIncidentAction` and `UpdateIncidentAction`, which resolve the caller's team with `requireTeamId` and verify that exactly one of `monitor_id` / `server_id` names a row in that team; the update action refuses to change either column. This also closes the pre-existing monitor-keyed variant of the same forgery, which the previous draft deferred.
11. **The transaction API is `transaction(async (tx) => …)` from `@stacksjs/orm`.** `@stacksjs/database`'s index exports only `runInTransactionScope` / `enqueueAfterCommit` / `isInTransaction`; the ORM's `transaction()` is `runInTransactionScope(() => db.transaction(cb, opts))` — it runs the query builder's own transaction under the after-commit scope that buffers model observer callbacks until commit. Its contract (`node_modules/@stacksjs/orm/dist/transaction.d.ts`): every query that belongs to the transaction executes through `tx`; model calls (`Incident.create`, `Monitor.find`) are a separate executor and are not bound to `tx`. So inside every callback in this spec only `tx.selectFrom / insertInto / updateTable / deleteFrom` appear, and model calls happen after the callback returns. **Serialisation, substantiated and narrowed:** `@stacksjs/database`'s `getDb()` wraps `instance.transaction` with `applySqliteTransactionSerialization` on the sqlite dialect, which chains every transaction through one promise tail per process. So "one writer of `servers.status` at any instant" is true **within one process**; it says nothing across processes, and on this app the ingest (web) and `CheckStaleServers` (queue worker) are different processes. §4.3 therefore writes `servers.status` with a compare-and-set on `last_sample_at`, and §4.1's resolve-all / update-oldest handles a duplicate-open race the same way as before.
12. **Widening the window on a quiet server** (§6.2 `DashboardUpdateServerAction`) produces the state the previous §4.3 said "cannot happen": `status = 'quiet'`, not overdue, `server_silent` open. The tick now recomputes the status from the fleet for every non-overdue server (§4.3), so that state self-heals within a minute without waiting for a push.
13. **Token minting stops in step 2, not step 4.** The previous ship order left `CreateMonitorAction`, `DashboardCreateMonitorAction` and `DashboardUpdateMonitorAction` minting `monitors.metrics_token` through step 3, so (i) every re-run of `servers:backfill` would have hit phase B and nulled a token an operator had just minted and was still installing, and (ii) a token minted after the `--final` run would have been stranded by 0000000285 with no server. Now the monitor-action / `monitorForm` cleanup of §6.2 ships with step 2, so from the moment new code is live no path mints a monitor token, and phase B on any run can only ever see tokens that predate step 2. §8 also runs `servers:backfill --final` once more immediately before step 6. §3.2's "which agents break" claim is restated in those terms.

---

## 1. Models

### 1.1 `app/Models/Server.ts` (new, complete)

```ts
import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One physical (or virtual) box. Owns the agent ingest token, the
 * CPU/memory/disk alert thresholds, the missed-push window, the host metric
 * history (ServerMetricSample), its own status, and the two server-level
 * incidents: "box is hot" (a threshold breach) and "agent went quiet" (no
 * push inside the window). Both are issues, never outages.
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
      // Read-only over the generated API. `store` is Actions/Servers/
      // CreateServerAction (metricsToken is hidden:true, and the auto-CRUD
      // store strips hidden fields from write bodies, so a generated store
      // could never mint the credential). `update` and `destroy` are NOT
      // generated: the generated update filters only by `fillable`, and the
      // generated destroy deletes the row alone, leaving monitors with a
      // dangling server_id and orphaned samples and incidents. Both go
      // through the team-scoped form actions in Actions/Servers/.
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
    // Explicit team_id, as on every tenant-owned model in app/Models (see
    // MonitorTag.ts, StatusPage.ts). Team lives in storage/framework/defaults.
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

    // Unguessable token that IS the auth for POST /api/agent/{token}/metrics —
    // same convention as HeartbeatMonitor.pingToken. Carried over verbatim
    // from monitors.metrics_token by `buddy servers:backfill`, so an agent
    // installed before this model existed keeps working untouched.
    metricsToken: {
      order: 2,
      fillable: true,
      unique: true,
      // Anyone who can read it can inject fake samples, so it must never
      // serialize into an API response (same reasoning as User.password's
      // hidden flag). Minted server-side in CreateServerAction /
      // DashboardCreateServerAction because hidden:true also strips it from
      // write bodies.
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
    // fleet verdict (ReceiveMetricsAction and the CheckStaleServers tick)
    // AND the missed-push deadline in CheckStaleServers. Splitting them lets
    // a box be permanently "hot" from a host that stopped reporting, or
    // permanently quiet-but-green.
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
    // fresh host is breaching (reachable, busy); 'quiet' the agent has not
    // pushed inside the window; 'unknown' never received a sample.
    // NOT fillable: written only by ReceiveMetricsAction, CheckStaleServers
    // and the backfill, through the query builder, so neither the dashboard
    // update action nor any API write can silence the quiet detector.
    status: {
      order: 7,
      fillable: false,
      default: 'unknown',
      validation: {
        rule: schema.enum(['unknown', 'healthy', 'hot', 'quiet']),
      },
      factory: faker => faker.helpers.arrayElement(['unknown', 'healthy', 'hot']),
    },

    // Denormalised newest sampled_at across every host on this box. The
    // missed-push baseline and the "last sample 42s ago" readouts come from
    // here rather than a MAX() over the samples table on every tick and page.
    // Written in the same transaction as the sample insert, and the value the
    // tick's compare-and-set keys on (§4.3). Not fillable, same reason as
    // status.
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
```

`app/lib/agentHosts.ts` gains the shared type and the one mapping from a fleet verdict to a server status (§3.5):

```ts
export type ServerStatus = 'unknown' | 'healthy' | 'hot' | 'quiet'
export const SERVER_STATUSES: readonly ServerStatus[] = ['unknown', 'healthy', 'hot', 'quiet']
```

### 1.2 `app/Models/ServerMetricSample.ts` (new, complete)

```ts
import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One agent push: a CPU/memory(/disk) reading from one host on one Server.
 *
 * Its own table, not check_results rows tagged region='agent'. A sample is
 * not a check: it has no status code, no response time, and must never vote
 * in uptime.ts / consensusStatus — it used to, and a healthy CPU sample
 * out-voted a failing probe (§5). Keeping samples out of check_results makes
 * every present and future reader of that table correct without a region
 * predicate; the invariant is pinned by tests/feature/server-metrics.test.ts
 * ("a push writes zero check_results rows").
 *
 * Minimal shape (no uuid, no API): this is the highest-volume table after
 * check_results — one row per host per minute — and nothing addresses a
 * sample individually. Pruned by PruneOldServerMetricSamples.
 */
export default defineModel({
  name: 'ServerMetricSample',
  table: 'server_metric_samples',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useTimestamps: true,
  },

  belongsTo: ['Server'],

  attributes: {
    // Normalised machine label (see app/lib/agentHosts.ts normalizeHost);
    // 'default' when the agent sent none.
    host: {
      order: 1,
      fillable: true,
      required: true,
      default: 'default',
      validation: {
        rule: schema.string().required().max(64),
      },
      factory: () => 'default',
    },

    cpuPercent: {
      order: 2,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.float({ min: 0, max: 100 }),
    },

    ramPercent: {
      order: 3,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: faker => faker.number.float({ min: 0, max: 100 }),
    },

    ramUsedMb: {
      order: 4,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 512, max: 32768 }),
    },

    ramTotalMb: {
      order: 5,
      fillable: true,
      required: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: () => 32768,
    },

    // Null when the agent did not report disk; disk alerting is skipped then.
    diskPercent: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0).max(100),
      },
      factory: () => null,
    },

    // JSON array of the human-readable breach strings evaluated at ingest
    // time (evaluateBreaches), persisted so the fleet verdict can be
    // recomputed from stored rows without re-applying thresholds that may
    // since have been edited. Same convention as CheckResult.metadata.
    breaches: {
      order: 7,
      fillable: true,
      default: '[]',
      validation: {
        rule: schema.string(),
      },
      factory: () => JSON.stringify([]),
    },

    sampledAt: {
      order: 8,
      fillable: true,
      required: true,
      validation: {
        rule: schema.string().required(),
      },
      factory: faker => faker.date.recent().toISOString(),
    },
  },
} as const)
```

Note: the model declares `schema.number()` (which the generator would map to `INTEGER`), but the hand-written migration below uses `REAL` for the four percent/MB columns. `37.2` in an `INTEGER`-affinity SQLite column survives (affinity only converts losslessly), but on Postgres it would truncate; `REAL` parses on both dialects. We never run `buddy generate:migrations` against this table.

### 1.3 `app/Models/Monitor.ts` (edit)

Add after `consecutiveFailures` (order 9); delete `reportsMetrics` (order 10) and `metricsToken` (order 11) in ship step 6, not before:

```ts
    // The box this site runs on, or null for anything without an agent (a
    // third-party API, a CDN edge). Nullable and explicit rather than
    // `belongsTo: ['Server']` — same technique as TeamMember.userId. Set only
    // by the dashboard server actions and CreateMonitorAction, each of which
    // checks the server belongs to the monitor's team.
    serverId: {
      order: 12,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },
```

`hasMany: ['CheckResult', 'Incident']` unchanged. `belongsTo: ['Team']` unchanged. The `teamId` comment at `Monitor.ts:36-39` claims a relation to a model outside `app/Models` "silently produces no FK column at all"; do not copy that claim into `Server.ts` (the neutral one-line comment in §1.1 is what the six newer models use). The explicit attribute stays: the installed `node_modules/@stacksjs/database/dist/model-sources.js` still excludes `storage/framework/defaults/app/Models` unless `config.database.models.includeFrameworkDefaults === true` or `STACKS_INCLUDE_FRAMEWORK_MODELS=1`, so the explicit attribute is the belt-and-braces; only the comment's wording is stale. Leave Monitor's comment alone in this PR.

### 1.4 `app/Models/Incident.ts` (edit)

Add after `impactedChecks` (order 5):

```ts
    // Set — with monitorId left null — on the two server-level incidents, a
    // threshold breach and a missed push, which belong to the box rather than
    // to any one site on it. One hot box is one incident, however many
    // monitors sit on it. Explicit nullable attribute, as Monitor.serverId.
    //
    // Incident has no team_id: an incident's team is its monitor's or its
    // server's. That is why POST /api/incidents and PATCH /api/incidents/{id}
    // are overridden in routes/api.ts (Actions/Incidents/CreateIncidentAction,
    // UpdateIncidentAction) rather than left to the generated store/update,
    // which would accept any monitor_id / server_id and, through
    // observe:true, page that row's team with the caller's text.
    serverId: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
      factory: () => null,
    },
```

`belongsTo: ['Monitor']` stays. `useApi.routes` stays `['index', 'store', 'show', 'update']` — the store and update routes are overridden, not removed, so the generated `index`/`show` keep their auth middleware and the two overrides take priority the way `route.post('/monitors', …)` already does for monitors. Every server incident has exactly one of `monitor_id` / `server_id` non-null. The live `incidents` table is the one `0000000118-create-incidents-table.sql` created (`0000000215` is `IF NOT EXISTS` and never applied): `"monitor_id" INTEGER REFERENCES "monitors"("id")` with no `NOT NULL`, and a `status` CHECK. `NULL` passes the FK, so server incidents need only the one `ADD COLUMN` in §2.

---

## 2. Migrations

All SQLite-valid, all parse on Postgres, all additive except the final DROP (ship step 6). Filenames continue from `0000000280`.

### `0000000281-create-servers-table.sql`

```sql
-- Server: one physical box with one identity above Monitor. Owns the agent
-- ingest token, CPU/memory/disk thresholds, the missed-push window, its own
-- status, the sample history (server_metric_samples) and the box-level
-- incidents. Before this, all of that lived on each Monitor
-- (monitors.metrics_token, monitors.reports_metrics, threshold keys inside
-- monitors.config), so two monitors on one box were two tokens, two
-- threshold sets and two incidents for one hot CPU.
--
-- Hand-written, additive-only, like 0000000252/0000000279: types chosen to
-- parse on both SQLite (self-hosted) and Postgres (hosted). Column order
-- matches what the generator would emit from app/Models/Server.ts (id, then
-- attributes by `order`, then created_at/updated_at/uuid). The status CHECK
-- follows 0000000118's incidents.status precedent.
CREATE TABLE IF NOT EXISTS "servers" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "team_id" INTEGER,
  "name" TEXT,
  "metrics_token" TEXT,
  "cpu_threshold" INTEGER default 90,
  "ram_threshold" INTEGER default 90,
  "disk_threshold" INTEGER default 85,
  "metrics_window_seconds" INTEGER default 300,
  "status" TEXT CHECK ("status" IN ('unknown', 'healthy', 'hot', 'quiet')) default 'unknown',
  "last_sample_at" TEXT,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT,
  "uuid" TEXT
);
-- The token is the whole credential for the public ingest route and is
-- looked up on every push. monitors.metrics_token never had an index or a
-- uniqueness guarantee (0000000193), so `.first()` silently took an
-- arbitrary match; here a duplicate is a hard error.
CREATE UNIQUE INDEX IF NOT EXISTS "servers_metrics_token_unique" ON "servers" ("metrics_token");
CREATE UNIQUE INDEX IF NOT EXISTS "servers_uuid_unique" ON "servers" ("uuid");
CREATE INDEX IF NOT EXISTS "servers_team_id_index" ON "servers" ("team_id");
```

### `0000000282-create-server_metric_samples-table.sql`

```sql
-- Agent-pushed host samples, in their own table rather than as
-- check_results rows tagged region='agent'.
--
-- The old placement had a correctness bug that could not be fixed by
-- filtering alone: app/lib/uptime.ts and config/regions.ts consensusStatus
-- treated 'agent' as one more voting region, so a healthy CPU sample
-- out-voted a genuinely failing probe (100 consecutive 'down' probe checks
-- interleaved with healthy agent pushes computed as 100% uptime), and
-- table-wide readers with no monitor predicate (CheckWorkerHealth's
-- dead-man's switch, the monitor index's checks-in-range count) counted
-- samples as checks. A separate table makes every reader of check_results
-- correct by construction — a sample physically cannot be a vote.
--
-- Typed REAL columns instead of a JSON blob so hourly rollups are one
-- GROUP BY on either dialect instead of "SELECT every row, JSON.parse,
-- reduce in JS" forever. cpu_percent / ram_percent are NOT NULL on purpose:
-- a row in this table IS a reading, and the backfill drops (and counts)
-- legacy agent rows that carry no reading rather than storing blanks here.
-- No uuid: nothing addresses a sample individually, and this is one row per
-- host per minute.
--
-- Same shape as ci_runner_samples (0000000114): a self-pruning samples
-- table with a (key, time) composite and a bare time index for the sweep.
-- The indexes ship here, with the table, on purpose: 0000000259 records
-- that check_results ran with no secondary index at all for a long time.
CREATE TABLE IF NOT EXISTS "server_metric_samples" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "host" TEXT NOT NULL DEFAULT 'default',
  "cpu_percent" REAL NOT NULL,
  "ram_percent" REAL NOT NULL,
  "ram_used_mb" REAL NOT NULL,
  "ram_total_mb" REAL NOT NULL,
  "disk_percent" REAL,
  "breaches" TEXT NOT NULL DEFAULT '[]',
  "sampled_at" TEXT NOT NULL,
  "server_id" INTEGER NOT NULL,
  "created_at" TEXT not null default CURRENT_TIMESTAMP,
  "updated_at" TEXT
);
-- Serves: the fleet window read in ReceiveMetricsAction and CheckStaleServers
--   WHERE server_id = ? AND sampled_at >= ? ORDER BY sampled_at DESC
-- the per-host series the server page charts
--   WHERE server_id = ? AND host = ? AND sampled_at >= ?
-- and latest-per-host.
CREATE INDEX IF NOT EXISTS "server_metric_samples_server_id_host_sampled_at_index" ON "server_metric_samples" ("server_id", "host", "sampled_at");
CREATE INDEX IF NOT EXISTS "server_metric_samples_server_id_sampled_at_index" ON "server_metric_samples" ("server_id", "sampled_at");
-- Retention sweep (PruneOldServerMetricSamples): WHERE sampled_at < ?
CREATE INDEX IF NOT EXISTS "server_metric_samples_sampled_at_index" ON "server_metric_samples" ("sampled_at");
```

### `0000000283-alter-monitors-server_id.sql`

```sql
-- Which box this monitor's site runs on. Nullable: a monitor with no agent
-- (a third-party API, a CDN) has none and behaves exactly as before.
--
-- Hand-written ALTER rather than a generated migration, for the reason
-- 0000000255 records: for a pre-existing table the generator emits a
-- dual-dialect table rebuild, and this app is live on SQLite.
ALTER TABLE "monitors" ADD COLUMN "server_id" INTEGER;
CREATE INDEX IF NOT EXISTS "monitors_server_id_index" ON "monitors" ("server_id");
```

### `0000000284-alter-incidents-server_id.sql`

```sql
-- Box-level incidents (threshold breach, missed push) belong to a Server,
-- not to one of the monitors that happen to sit on it, so a hot box is one
-- incident and one notification fan-out. For those rows server_id is set
-- and monitor_id is NULL (the live table, from 0000000118, has no NOT NULL
-- on monitor_id and its FK accepts NULL). Same hand-written-ALTER rationale
-- as 0000000283.
ALTER TABLE "incidents" ADD COLUMN "server_id" INTEGER;
CREATE INDEX IF NOT EXISTS "incidents_server_id_index" ON "incidents" ("server_id");
```

### Backfill — `app/Commands/BackfillServers.ts`, run as `buddy servers:backfill [--final]`

Not SQL. The thresholds live in `monitors.config` JSON and the samples live in `check_results.metadata` JSON; parsing them in SQL is `json_extract` on SQLite and `::json->>` on Postgres, and the app's own views refuse `json_extract` for that reason (`monitors/[id].stx:387-390`). A TypeScript command reuses `parseMetricsThresholds` and `readingsFromRows` byte-for-byte, so no customer's tuned threshold or historical sample is reinterpreted. Registered the way `app/Commands/Realtime.ts` registers `realtime` (`export default function (cli: CLI)`), with `servers:backfill` and `servers:rollback`.

**Transactions.** Every transactional block below is `transaction(async (tx) => { … })` imported from `@stacksjs/orm` — the only transaction API the framework exposes to app code (§0.11). Inside the callback only `tx.*` query-builder calls appear; model calls are not bound to `tx` and are used only outside callbacks (phase C's `incident.update` / `IncidentUpdate.create` are model calls on purpose, so `incident:updated` fires and the resolved-notification listener runs). On SQLite the framework serialises transactions per process, so a running backfill and a running web process interleave at batch granularity, not statement granularity.

**Population (plan rules 1–4, verbatim).** Group monitors by `metrics_token`:

```sql
SELECT m.id, m.team_id, m.name, m.config, m.metrics_token, m.server_id,
       (SELECT COUNT(*) FROM check_results c WHERE c.monitor_id = m.id AND c.region = 'agent') AS agent_rows
FROM monitors m
WHERE m.metrics_token IS NOT NULL
```

A token group **has samples** when `SUM(agent_rows) > 0` across its monitors. Only those groups get a server. `reports_metrics` is never read: a monitor with `reports_metrics = 0` and a live token ingests successfully today (`DashboardUpdateMonitorAction.ts:84-89` never clears the token and `ReceiveMetricsAction.ts:40` never checks the flag), so it is a live agent and is migrated; a monitor with `reports_metrics = 1` and no samples has never had an agent and gets nothing. Never mint a token.

**Phase A — servers and attachment.** Per token group with samples, in one `transaction`:

1. `server = tx.selectFrom('servers').where('metrics_token', '=', token).executeTakeFirst()`. If absent, insert with `tx.insertInto('servers')` (query builder, not the model — `status` and `last_sample_at` are not fillable):
   - `team_id`: the group's monitors must share one `team_id`; if they do not, abort the run with the monitor ids (a token shared across teams is a data error to fix by hand, not to guess at).
   - `name`: the name of the group's monitor with the most agent rows (ties: lowest id).
   - thresholds and window: `parseMetricsThresholds(thatMonitor.config)` — current semantics: defaults 90/90/85/300, non-numeric → default, window 0 → 300. Plan rule 2.
   - `last_sample_at = MAX(checked_at) FROM check_results WHERE monitor_id IN (group) AND region = 'agent'` — over **all** agent rows, including legacy rows with no numeric metrics, so no server is overdue on the first `CheckStaleServers` tick.
   - `status`: `aggregateHostStatus(readingsFromRows(agent rows with checked_at >= now - windowSeconds), now, windowSeconds)` → `'hot'` if `degraded`, else `'healthy'`; if no row is inside the window → `'quiet'` (there is a `last_sample_at`, so silence is real and the first tick raises `server_silent` under the new marker). Never `'unknown'` here — every server in this phase has a sample.
   - `metrics_token`: the group's token, verbatim. `uuid: crypto.randomUUID()`.
2. `tx.updateTable('monitors').set({ server_id }).where('metrics_token', '=', token).where('server_id', 'is', null)` — every monitor in the group, whatever its `reports_metrics`.
3. Do **not** null `monitors.metrics_token` on these monitors: the column is dropped in step 6 and leaving it makes `servers:rollback` a pure restore. The server lookup in the ingest hits first, so the monitor's copy is inert.

From this commit the monitor is outside `CheckStaleMetrics`' work set (`whereNull('server_id')`, §4.3), `CheckStaleServers` watches the server with a correct baseline (D6(d): `last_sample_at` is in the same insert that the attach commits with), and the ingest resolves the token to the server. The legacy agent rows are still in `check_results` until phase D and still vote in uptime until then — which is why phase D runs in the same invocation.

**Phase B — orphan tokens.** Per token group with **no** samples: `UPDATE monitors SET metrics_token = NULL, reports_metrics = 0 WHERE id IN (group)`. No server. `reports_metrics = 0` matters: until step 6 `CheckStaleMetrics` still runs, and with the flag left on it would re-open the perpetual missed-push incident phase C is about to resolve. Print the monitor ids and names: on production these are monitors 56, 57, 58 and 62, three of which are sites on the same shared box as monitor 48 and should be attached to that server by hand (the hostname suggestion cannot help — that agent reports `host = 'default'`). Because no code path mints a monitor token once step 2 is live (§0.13, §6.2), a token this phase sees on any run — first, second, or the pre-step-6 sweep — is one that existed before the new code deployed and has never pushed; there is no "operator is still installing it" case.

**Phase C — resolve open server incidents.** Every incident with `status != 'resolved'` whose `impacted_checks` JSON array contains an entry with `type === 'server_metrics'` (any position; both the breach shape and the `reason: 'missed_push'` shape), on any monitor, migrated or not:

```ts
await incident.update({ status: 'resolved', resolved_at: now })
await IncidentUpdate.create({
  incident_id: incident.id,
  message: 'Resolved by the server backfill. Host metrics now belong to a Server, which raises at most one "box is hot" and one "agent went quiet" incident per box; see the server page for its current state.',
  status: 'resolved',
  postedAt: now,
})
```

On production (plan, 2026-09-02) this closes the 45 open "host threshold breached" incidents — one monitor alone holds five of them — and the 5 open "agent went quiet" incidents (the four never-installed tokens plus the flag-off monitor whose token still exists). `monitor_id` is left in place and nothing is moved to the server: the plan says resolve, the monitor page keeps the history it always had, and the public status page's "Past incidents" list is unchanged. The next ingest or tick opens a fresh, correctly-deduped incident under the new marker if the box is still hot or quiet.

**Phase D — move samples, in id-range batches.** Per server, over `monitorIds` = the group's monitors:

```ts
import { transaction } from '@stacksjs/orm'

const BATCH = 1000
const { lo, hi } = await db.selectFrom('check_results')
  .where('monitor_id', 'in', monitorIds).where('region', '=', 'agent')
  .select([db.fn.min('id').as('lo'), db.fn.max('id').as('hi')]).executeTakeFirst()
if (lo == null) return
for (let from = lo; from <= hi; from += BATCH) {
  await transaction(async (tx) => {
    const rows = await tx.selectFrom('check_results')
      .where('monitor_id', 'in', monitorIds).where('region', '=', 'agent')
      .where('id', '>=', from).where('id', '<', from + BATCH)
      .select(['id', 'status', 'metadata', 'checked_at']).execute()
    if (rows.length === 0) return
    const convertible = [], metricless = []
    for (const row of rows) {
      const meta = safeJson(row.metadata)
      if (numberOrNull(meta.cpuPercent) === null || numberOrNull(meta.ramPercent) === null) { metricless.push(row); continue }
      convertible.push({
        server_id: server.id,
        host: normalizeHost(meta.host),
        cpu_percent: meta.cpuPercent, ram_percent: meta.ramPercent,
        ram_used_mb: numberOrNull(meta.ramUsedMb) ?? 0, ram_total_mb: numberOrNull(meta.ramTotalMb) ?? 0,
        disk_percent: numberOrNull(meta.diskPercent),
        // readingsFromRows treats a legacy status='down'/'degraded' row as
        // breaching even with no breaches array; readingsFromSamples reads
        // only the stored breaches, so give those rows a marker or they
        // backfill as healthy.
        breaches: JSON.stringify(Array.isArray(meta.breaches) && meta.breaches.length > 0
          ? meta.breaches.filter(b => typeof b === 'string')
          : (row.status === 'down' || row.status === 'degraded' ? ['threshold breached'] : [])),
        sampled_at: row.checked_at, created_at: row.checked_at,
      })
    }
    const before = await count(tx, server.id)
    if (convertible.length > 0) await tx.insertInto('server_metric_samples').values(convertible).execute()
    const after = await count(tx, server.id)
    // Row-count assertion BEFORE any source row is deleted:
    //   inserted == convertible   (every reading landed)
    //   convertible + metricless == read   (every source row is accounted for)
    // Metric-less rows are dropped by design (§0.6): the table's percent
    // columns are NOT NULL and the rows carry no reading; their timestamp
    // already reached servers.last_sample_at in phase A. A failure throws,
    // the transaction rolls back, the command exits non-zero and
    // check_results is untouched for this batch.
    if (after - before !== convertible.length || convertible.length + metricless.length !== rows.length)
      throw new Error(`servers:backfill: batch ${from}-${from + BATCH} read ${rows.length}, inserted ${after - before}, dropped ${metricless.length}`)
    await tx.deleteFrom('check_results').where('id', 'in', rows.map(r => r.id)).execute()
    totals.read += rows.length; totals.inserted += convertible.length; totals.dropped += metricless.length
  })
}
```

Each batch is a rowid range scan bounded by `BATCH`, never one statement over the table, so SQLite's single writer lock is held for one batch at a time and probe inserts and agent pushes interleave. The dropped count is reported per batch and in the totals.

**Phase E — verify and report.** Print servers created, monitors attached, orphan tokens dropped, incidents resolved, rows read / samples inserted / metric-less dropped, and `SELECT COUNT(*) FROM check_results WHERE region = 'agent'`. Assert `SELECT COUNT(*) FROM monitors WHERE metrics_token IS NOT NULL AND server_id IS NULL` is 0 (every live token is on a server, every dead one is gone). With `--final`, additionally assert the agent-row count is 0. Exit non-zero on any failed assertion.

**Idempotent, re-runnable.** A second run finds every server by token (no insert), every monitor attached (no update), no orphan tokens, no open `server_metrics` incidents, and sweeps whatever `region = 'agent'` rows an old-code process wrote while the first run was in flight. The runbook (§8) runs it twice in step 3 (the second with `--final`) and once more with `--final` immediately before step 6.

**`buddy servers:rollback`** (write with the forward command, test in `servers-backfill.test.ts`): per server, copy `server_metric_samples` back as `check_results` rows (`region: 'agent'`, `monitor_id` = the server's lowest-id monitor, `status` = `breaches !== '[]' ? 'degraded' : 'up'`, `metadata` = the JSON the old ingest wrote, `checked_at = sampled_at`), in the same batched, count-asserted, `transaction`-wrapped shape; resolve any open `server_hot` / `server_silent` incident with an `IncidentUpdate` ("Rolled back to per-monitor metrics"; model calls, outside the batch transactions); `UPDATE monitors SET server_id = NULL WHERE server_id = ?`; delete the samples and the server. `monitors.metrics_token` was never touched for migrated monitors, so the old ingest works immediately. Orphan tokens nulled in phase B are not restored — they never pushed. Rollback re-instates the voting bug (§5); it is a rollback.

Threshold keys left inside `monitors.config` are dead after this and are dropped naturally on the next dashboard save (`buildMonitorConfig` rebuilds config from `{}`).

### `0000000285-alter-monitors-drop-metrics-columns.sql` (ship step 6 only)

```sql
-- reports_metrics and metrics_token moved to servers (0000000281) and were
-- backfilled by `buddy servers:backfill`; every code path that read them is
-- gone. SQLite >= 3.35 supports DROP COLUMN in place for a plain column
-- (neither is indexed or constrained), so this is not the table rebuild the
-- Monitor model's reportsMetrics comment was written to avoid.
ALTER TABLE "monitors" DROP COLUMN "reports_metrics";
ALTER TABLE "monitors" DROP COLUMN "metrics_token";
```

After steps 1 and 6: `buddy generate:db-types` (gitignored `database/types.d.ts`; a stale copy lets old code keep typechecking, so regenerate before running `buddy test:types`).

---

## 3. Ingest

### 3.1 Route — unchanged

`routes/api.ts:69` stays byte-for-byte: `route.post('/agent/{token}/metrics', 'Actions/Agents/ReceiveMetricsAction').skipCsrf()`. Update only the comment above it (`metrics_token` → `servers.metrics_token`).

### 3.2 Deployed agents do not change — verified

- `public/install-agent.sh:190-193` POSTs to `"$STATUSHQ_URL/api/agent/$STATUSHQ_TOKEN/metrics"` with `STATUSHQ_TOKEN` read from the agent's env file on a 60-second timer, body `{cpuPercent, ramPercent, ramUsedMb, ramTotalMb, host[, diskPercent]}`.
- The backfill copies `monitors.metrics_token` **verbatim** into `servers.metrics_token` (§2 phase A). Same URL, same path segment, same token value, same payload fields, same response fields (`{ success, status, host, sampleStatus, breaches, hosts }`). The one value change: `status` in the response is now the server's (`healthy` / `hot`) instead of the monitor's (`up` / `degraded`); `sampleStatus` keeps `up` / `degraded`. The installer's collector and `@statushq/agent` (`packages/agent/src/cli.ts:120-131`) ignore the body; release-note it for anyone who wrote their own.
- `@statushq/agent` and `statushq/laravel-sdk` send the identical body to the identical URL.

Therefore no agent binary, config file, timer, or SDK is touched. **Which tokens stop working, precisely:** a token stops resolving only when phase B nulls it, and phase B nulls a token only when it has never produced a `region = 'agent'` row. Since step 2 removes every path that mints a monitor token (§6.2, shipped with step 2), the set of tokens phase B can see is fixed from the moment new code is live: tokens issued before step 2 whose agent was never installed. On the production data that set is the four never-installed tokens the plan names. A token issued before step 2 whose agent is installed between the read-only inspection and the backfill has samples by then and is migrated. No token can be issued after step 2 and before step 6 (the only way to get one is `POST /api/servers` or the server dialog, which mint `servers.metrics_token` directly), so nothing is stranded by 0000000285. `scripts/e2e-smoke.ts:340` (bogus token → 404) stays true.

### 3.3 `app/Actions/Agents/ReceiveMetricsAction.ts` (rewrite)

```ts
import { Action } from '@stacksjs/actions'
import { db } from '@stacksjs/database'
import { transaction } from '@stacksjs/orm'
import { response } from '@stacksjs/router'
import type { ServerStatus } from '../../lib/agentHosts'
import { aggregateHostStatus, normalizeHost, readingsFromSamples, serverStatusFromFleet } from '../../lib/agentHosts'
import { reconcileServerIncidents } from '../../lib/serverIncidents'
import { evaluateBreaches, thresholdsForServer } from './metricsThresholds'

function isValidPercent(n: number): boolean { return Number.isFinite(n) && n >= 0 && n <= 100 }
function isValidMb(n: number): boolean { return Number.isFinite(n) && n >= 0 }

/**
 * Public, unauthenticated: POST /api/agent/{token}/metrics. The token is
 * Server.metricsToken — unguessable, unique, and the whole credential.
 *
 * Writes a ServerMetricSample, recomputes the box's fleet verdict (latest
 * reading per fresh host; hot if any breaches), writes servers.status and
 * servers.last_sample_at in the same transaction as the insert, then
 * reconciles the box's own incidents from that state. It never touches a
 * Monitor: a sample says the box is busy or fine, nothing about whether any
 * site on it answers. (That is also why the monitor-49 probe-starvation
 * guard that used to live here is gone — there is no clock to starve.)
 */
export default new Action({
  name: 'ReceiveMetricsAction',
  description: 'Record a pushed CPU/RAM/disk sample for a server and alert on threshold breaches',

  async handle(request) {
    const token = request.get('token')
    const server = await db.selectFrom('servers').where('metrics_token', '=', token).selectAll().executeTakeFirst()
    if (!server)
      return response.json({ success: false, message: 'Unknown metrics token' }, { status: 404 })

    const cpuPercent = Number(request.get('cpuPercent'))
    const ramPercent = Number(request.get('ramPercent'))
    const ramUsedMb = Number(request.get('ramUsedMb'))
    const ramTotalMb = Number(request.get('ramTotalMb'))
    const rawDisk = request.get('diskPercent')
    const hasDisk = rawDisk !== undefined && rawDisk !== null && rawDisk !== ''
    const diskPercent = hasDisk ? Number(rawDisk) : null

    if (!isValidPercent(cpuPercent) || !isValidPercent(ramPercent) || !isValidMb(ramUsedMb) || !isValidMb(ramTotalMb) || (hasDisk && !isValidPercent(diskPercent as number))) {
      return response.json(
        { success: false, message: 'cpuPercent/ramPercent/diskPercent must be 0-100, ramUsedMb/ramTotalMb must be >= 0' },
        { status: 422 },
      )
    }

    const host = normalizeHost(request.get('host'))
    const thresholds = thresholdsForServer(server)
    const breaches = evaluateBreaches({ cpuPercent, ramPercent, diskPercent }, thresholds)
    const sampleStatus: 'up' | 'degraded' = breaches.length > 0 ? 'degraded' : 'up'
    const sampledAt = new Date().toISOString()
    const windowStart = new Date(Date.parse(sampledAt) - thresholds.windowSeconds * 1000).toISOString()

    // Insert, fleet read, and the status/baseline write are one transaction
    // (`transaction` from @stacksjs/orm; every statement through `tx`, no
    // model calls inside — they are not bound to the handle). last_sample_at
    // is the missed-push baseline, and a crash between the insert and the
    // update must not leave a sample the baseline does not know about.
    // Within this process the framework serialises SQLite transactions
    // (@stacksjs/database applySqliteTransactionSerialization), so two
    // pushes handled by the same web process cannot interleave here. Across
    // processes — the queue worker's CheckStaleServers tick is the only
    // other writer of servers.status — the tick's compare-and-set on
    // last_sample_at (§4.3) yields to a push that landed first.
    const { status, fleet } = await transaction(async (tx) => {
      await tx.insertInto('server_metric_samples').values({
        server_id: server.id, host, cpu_percent: cpuPercent, ram_percent: ramPercent,
        ram_used_mb: ramUsedMb, ram_total_mb: ramTotalMb, disk_percent: diskPercent,
        breaches: JSON.stringify(breaches), sampled_at: sampledAt, created_at: sampledAt,
      }).execute()

      // The box's status is the whole fleet's, not this sample's (two hosts
      // taking turns would otherwise flap it once a minute).
      const recent = await tx.selectFrom('server_metric_samples')
        .where('server_id', '=', server.id).where('sampled_at', '>=', windowStart)
        .orderBy('sampled_at', 'desc').orderBy('id', 'desc').selectAll().execute()
      const fleet = aggregateHostStatus(readingsFromSamples(recent), Date.parse(sampledAt), thresholds.windowSeconds)
      const status: ServerStatus = serverStatusFromFleet(fleet)   // 'hot' | 'healthy'

      await tx.updateTable('servers')
        .set({ status, last_sample_at: sampledAt, updated_at: sampledAt })
        .where('id', '=', server.id).execute()
      return { status, fleet }
    })

    // State, not edge: a push is proof the agent is alive (closes any open
    // "agent went quiet"), 'healthy' closes any open "box is hot", and 'hot'
    // opens one or updates the one that is open. Model calls, after commit
    // on purpose, so incident:created / incident:updated fire normally.
    // See serverIncidents.ts.
    await reconcileServerIncidents({ ...server, status }, sampledAt, fleet)

    return { success: true, status, host, sampleStatus, breaches, hosts: fleet.hosts.length }
  },
})
```

What is gone, deliberately: `Monitor.where('metrics_token')`, `CheckResult.create`, `monitor.update({ status, last_checked_at, consecutive_failures })`, `isActivelyPolled`, the `prev !== 'degraded' && status === 'degraded'` open edge and the `(prev === 'degraded' || prev === 'down') && status === 'up'` resolve edge (the root cause of the stacked incidents — `monitors.status` had two writers, so the ingest's `prev` was routinely spent by the check job), the newest-unresolved-incident-of-any-kind resolve at old lines 176-189 (it could resolve an SSL or DNS incident on a healthy CPU push), and `broadcastMonitorUpdate` (§6.10: nothing about the monitor changed, so there is nothing to broadcast).

### 3.4 `app/Actions/Agents/metricsThresholds.ts` (edit)

Replace `parseMetricsThresholds(configJson)` with:

```ts
/** Thresholds and window from a servers row (columns, not config JSON). */
export function thresholdsForServer(server: { cpu_threshold?: unknown, ram_threshold?: unknown, disk_threshold?: unknown, metrics_window_seconds?: unknown }): MetricsThresholds {
  return {
    cpu: nonNegNumber(server.cpu_threshold, DEFAULT_METRICS_THRESHOLDS.cpu),
    ram: nonNegNumber(server.ram_threshold, DEFAULT_METRICS_THRESHOLDS.ram),
    disk: nonNegNumber(server.disk_threshold, DEFAULT_METRICS_THRESHOLDS.disk),
    windowSeconds: nonNegNumber(server.metrics_window_seconds, DEFAULT_METRICS_THRESHOLDS.windowSeconds) || DEFAULT_METRICS_THRESHOLDS.windowSeconds,
  }
}
```

Keep `parseMetricsThresholds` exported until ship step 6 (the backfill command and the ingest fallback use it), then delete it. `DEFAULT_METRICS_THRESHOLDS`, `evaluateBreaches`, `MetricsThresholds`, `MetricsSample` unchanged. Update the module docblock (it says thresholds live in config).

### 3.5 `app/lib/agentHosts.ts` (edit)

Export `numberOrNull` (it is module-private at `:68`; the backfill uses it). Add, next to `readingsFromRows`:

```ts
interface SampleRow {
  host?: string | null
  breaches?: string | null
  sampled_at?: string | null
  cpu_percent?: number | null
  ram_percent?: number | null
  disk_percent?: number | null
}

/** Parse server_metric_samples rows into readings. Breaches are the stored verdict. */
export function readingsFromSamples(rows: readonly SampleRow[]): HostReading[] {
  const readings: HostReading[] = []
  for (const row of rows) {
    const checkedAtMs = Date.parse(row.sampled_at ?? '')
    if (!Number.isFinite(checkedAtMs))
      continue
    let breaches: string[] = []
    try {
      const parsed = JSON.parse(row.breaches ?? '[]')
      breaches = Array.isArray(parsed) ? parsed.filter((b): b is string => typeof b === 'string') : []
    }
    catch {
      breaches = []
    }
    readings.push({
      host: normalizeHost(row.host),
      status: breaches.length > 0 ? 'degraded' : 'up',
      breaches,
      checkedAtMs,
      cpuPercent: numberOrNull(row.cpu_percent),
      ramPercent: numberOrNull(row.ram_percent),
      diskPercent: numberOrNull(row.disk_percent),
    })
  }
  return readings
}

export type ServerStatus = 'unknown' | 'healthy' | 'hot' | 'quiet'
export const SERVER_STATUSES: readonly ServerStatus[] = ['unknown', 'healthy', 'hot', 'quiet']

/** The box's status from its fleet verdict. A fleet with fresh readings can only ever say healthy or hot. */
export function serverStatusFromFleet(fleet: HostAggregate): ServerStatus {
  return fleet.status === 'degraded' ? 'hot' : 'healthy'
}
```

`readingsFromSamples` reads only the stored breaches, where `readingsFromRows` also treats a legacy `status = 'down'` row without a breaches array as breaching; the backfill synthesises a `['threshold breached']` marker for those rows (§2 phase D) so the two agree. `readingsFromRows` stays until step 6 (backfill needs it), then is deleted. `HostReading`, `latestPerHost`, `aggregateHostStatus`, `describeBreaches`, `normalizeHost`, `DEFAULT_HOST` unchanged; the docblocks that say "CheckStaleMetrics' business" become "CheckStaleServers' business".

### 3.6 Coexistence fallback (ship step 2 only, removed in step 6)

Between deploying the new ingest and running the backfill there are no `servers` rows. So in step 2 the action carries, after the `servers` lookup misses:

```ts
    if (!server) {
      // Pre-backfill: the token is still on the monitor. Delegate to the
      // legacy path unchanged; `buddy servers:backfill` moves it.
      const legacy = await Monitor.where('metrics_token', token).first()
      if (legacy) return legacyHandle(request, legacy)
      return response.json({ success: false, message: 'Unknown metrics token' }, { status: 404 })
    }
```

where `legacyHandle` is today's handler body moved verbatim into `app/Actions/Agents/legacyReceiveMetrics.ts`. After step 3 every existing token is either on a server (the first branch hits) or nulled (404), and nothing mints new monitor tokens (§0.13), so from step 3 to step 6 this branch is unreachable; step 6 deletes the file and the branch.

---

## 4. Thresholds, incidents, one hot box → one incident

### 4.1 `app/lib/serverIncidents.ts` (new)

```ts
import { log } from '@stacksjs/logging'
import type { HostAggregate, ServerStatus } from './agentHosts'
import { describeBreaches } from './agentHosts'
import { isMonitorInMaintenance } from './maintenance'
import Incident from '../Models/Incident'
import IncidentUpdate from '../Models/IncidentUpdate'
import Monitor from '../Models/Monitor'

export type ServerIncidentKind = 'server_hot' | 'server_silent'

export interface ServerRow {
  id: number
  team_id: number
  name: string
  status: ServerStatus
  metrics_window_seconds: number | null
}

type HotMarker = { type: 'server_hot', hosts: { host: string, breaches: string[] }[] }
type SilentMarker = { type: 'server_silent', reason: 'missed_push', windowSeconds: number }

/** True when the box has monitors and every one of them is inside a maintenance window. */
export async function isServerInMaintenance(serverId: number, atMs = Date.now()): Promise<boolean> {
  const monitors = await Monitor.where('server_id', serverId).get()
  if (monitors.length === 0) return false
  for (const m of monitors) {
    if (!(await isMonitorInMaintenance(m.id, atMs))) return false
  }
  return true
}

function markerOf(incident: { impacted_checks?: string | null }): HotMarker | SilentMarker | null {
  try {
    const first = JSON.parse(incident.impacted_checks || '[]')[0]
    return first?.type === 'server_hot' || first?.type === 'server_silent' ? first : null
  }
  catch { return null }
}

/** The open incident of one kind on a server (oldest first), or null. */
export async function openServerIncidentOfKind(serverId: number, kind: ServerIncidentKind): Promise<any | null> {
  const open = await Incident.where('server_id', serverId).where('status', '!=', 'resolved').orderBy('id', 'asc').get()
  return open.find((i: any) => markerOf(i)?.type === kind) ?? null
}

/** Resolve every open incident of one kind on a server, posting one update each. Returns how many. */
export async function resolveServerIncidents(serverId: number, kind: ServerIncidentKind, resolvedAt: string, message: string): Promise<number> {
  const open = await Incident.where('server_id', serverId).where('status', '!=', 'resolved').get()
  let n = 0
  for (const incident of open) {
    if (markerOf(incident as any)?.type !== kind) continue
    await (incident as any).update({ status: 'resolved', resolved_at: resolvedAt })
    await IncidentUpdate.create({ incident_id: (incident as any).id, message, status: 'resolved', postedAt: resolvedAt })
    n++
  }
  return n
}

async function createServerIncident(server: ServerRow, startedAt: string, cause: string, marker: HotMarker | SilentMarker): Promise<any | null> {
  if (await isServerInMaintenance(server.id, Date.parse(startedAt))) {
    log.debug(`[maintenance] suppressed server incident for server ${server.id}`)
    return null
  }
  // monitorId null on purpose; the ORM snake-cases keys and exempts *_id
  // from the fillable guard, so camelCase here is the same as maintenance.ts's
  // ATTR_ALIASES normalisation.
  return (Incident as any).create({
    monitorId: null,
    serverId: server.id,
    startedAt,
    cause,
    status: 'investigating',
    impactedChecks: JSON.stringify([marker]),
  })
}

function hotMarker(fleet: HostAggregate): HotMarker {
  return {
    type: 'server_hot',
    hosts: fleet.breaching
      .map(r => ({ host: r.host, breaches: [...r.breaches].sort() }))
      .sort((a, b) => a.host.localeCompare(b.host)),
  }
}

function sameBreachSet(a: HotMarker | SilentMarker | null, b: HotMarker): boolean {
  return a?.type === 'server_hot' && JSON.stringify(a.hosts) === JSON.stringify(b.hosts)
}

/**
 * Reconcile the box's two incidents from its STATE — never from an edge.
 * Called after every ingest and every CheckStaleServers tick, each with
 * the fleet it just computed from the windowed samples (a 'quiet' tick has
 * no fresh readings and passes none). Idempotent: running it twice with the
 * same state does nothing the second time. Dedup is by marker kind; the
 * cause string embeds live percentages and can never be a dedup key.
 *
 *   healthy → resolve any open server_hot and server_silent
 *   hot     → resolve any open server_silent; open ONE server_hot if none,
 *             else update the open one in place when the breach set changed
 *   quiet   → open ONE server_silent if none (server_hot is left as it was:
 *             silence says nothing new about heat; the next push settles it)
 *   unknown → nothing (never heard from is not went quiet)
 *
 * This is the same reasoning EvaluateMonitorConsensus.ts:141-171 applies to
 * monitor recovery, and the reason a monitor can never again hold five open
 * breach incidents at once: there is one status column, one writer per
 * instant in each process, a compare-and-set between processes, and at most
 * one open incident of each kind.
 */
export async function reconcileServerIncidents(server: ServerRow, at: string, fleet?: HostAggregate): Promise<void> {
  if (server.status === 'unknown') return

  if (server.status !== 'quiet')
    await resolveServerIncidents(server.id, 'server_silent', at, 'Agent metrics are being received again.')

  if (server.status === 'healthy') {
    await resolveServerIncidents(server.id, 'server_hot', at, 'Host resource usage back within thresholds.')
    return
  }

  if (server.status === 'hot') {
    // Both callers pass a fleet for a 'hot' server (the ingest computes it
    // in its transaction, the tick recomputes it from the windowed samples).
    // A fleet with nothing breaching alongside status 'hot' is a stale
    // status the tick is about to rewrite (§4.3); do nothing this round.
    if (!fleet || fleet.breaching.length === 0) return
    const marker = hotMarker(fleet)
    const cause = `Host resource threshold breached: ${describeBreaches(fleet.breaching)}`
    const open = await openServerIncidentOfKind(server.id, 'server_hot')
    if (!open) {
      await createServerIncident(server, at, cause, marker)
    }
    else if (!sameBreachSet(markerOf(open), marker)) {
      // Update in place. incident:updated does not re-page (the notification
      // listeners fire on created and on status = resolved only), so a
      // breach that spreads to a second host is visible on the page without
      // waking anyone up twice.
      await open.update({ cause, impacted_checks: JSON.stringify([marker]) })
      await IncidentUpdate.create({ incident_id: open.id, message: `Breaches changed: ${describeBreaches(fleet.breaching)}`, status: open.status, postedAt: at })
    }
    return
  }

  // quiet
  const windowSeconds = server.metrics_window_seconds || 300
  if (!(await openServerIncidentOfKind(server.id, 'server_silent'))) {
    await createServerIncident(server, at,
      `No metrics received from '${server.name}' agent within ${windowSeconds}s`,
      { type: 'server_silent', reason: 'missed_push', windowSeconds })
  }
}
```

`postedAt` camelCase throughout (the model declares it required in camelCase; the old ingest's `posted_at` at line 150 was a latent bug — `app/lib/maintenance.ts:182-192` explains why snake_case reads as missing). This function is model calls only and runs outside any transaction: the ORM's transaction handle does not bind model calls, and the observers (`incident:created`, `incident:updated`) are wanted here. Two reconciles for one server racing across two processes (a push in the web process and a tick in the queue worker) could each see "no open `server_hot`" and both create one; `resolveServerIncidents` resolves all of a kind and `openServerIncidentOfKind` updates the oldest, so the duplicate is closed at the next `healthy` and is never a third. Within one process SQLite transactions are serialised by the framework and the ingest's reconcile follows its own commit, so the race is cross-process only.

### 4.2 Incident markers and severity

| Kind | `impacted_checks[0]` | Cause | Severity |
|---|---|---|---|
| Box is hot | `{ type: 'server_hot', hosts: [{host, breaches}] }` (hosts and breaches sorted) | `Host resource threshold breached: <describeBreaches>` | `issue` |
| Agent went quiet | `{ type: 'server_silent', reason: 'missed_push', windowSeconds }` | `No metrics received from '<server.name>' agent within <w>s` | `issue` (see §9.2) |

`app/lib/notificationSeverity.ts`: `const ISSUE_CHECK_TYPES = new Set(['server_metrics', 'server_hot', 'server_silent'])`. `server_metrics` stays in the set so the historical incidents the backfill resolved keep rendering amber. Nothing routes as `down` from a server: a box being hot means it answered, and a silent agent says nothing about whether the sites on it answer — their own monitors decide that. Server incidents are passed `monitorType = ''`. Update the docblock that says "a `server` monitor has two failure modes" to describe the two server-level kinds.

### 4.3 `app/Jobs/CheckStaleServers.ts` (new; replaces `CheckStaleMetrics`)

```ts
import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { thresholdsForServer } from '../Actions/Agents/metricsThresholds'
import { aggregateHostStatus, readingsFromSamples, serverStatusFromFleet } from '../lib/agentHosts'
import { reconcileServerIncidents } from '../lib/serverIncidents'

/**
 * Every minute. Two jobs:
 *
 *  1. A box whose agent has not pushed inside its window is marked 'quiet'
 *     (the agent went quiet — the box may be gone) and gets one box-level
 *     incident. A box that has never pushed is skipped: 'unknown' is not
 *     'quiet', so a server created in the dashboard does not page five
 *     minutes later while the operator is still running the installer.
 *
 *  2. Every box that IS inside its window has its status recomputed from
 *     the same windowed fleet the ingest uses and its incidents reconciled
 *     from that state (§4.1). This is what makes the state machine hold on
 *     the tick as well as on the push: a 'hot' server with no open
 *     server_hot (a crash between the ingest's status write and its
 *     reconcile, or the post-backfill state) gets its incident within a
 *     minute; a breaching host that aged out of the window while another
 *     host kept pushing turns the box 'healthy' without waiting for the
 *     next push; and a 'quiet' server whose window an operator just widened
 *     (DashboardUpdateServerAction) leaves 'quiet' and closes its
 *     server_silent as soon as the samples say so.
 *
 * Every status write is a compare-and-set on last_sample_at: this job runs
 * in the queue worker, the ingest in the web process, and SQLite's
 * per-process transaction serialisation does not order them. If a push
 * landed between this tick's read and its write, the UPDATE matches zero
 * rows and the server is skipped for this tick — the push's own reconcile
 * already ran on fresher data.
 *
 * Nothing here writes a Monitor: the sites on the box keep their own
 * verdicts from their own checks, so the CheckStaleMetrics /
 * EvaluateMonitorConsensus tug-of-war that EvaluateMonitorConsensus.ts's
 * docblock describes has no two writers left to happen between.
 */
export default new Job({
  name: 'CheckStaleServers',
  description: 'Reconcile server status and incidents from the windowed samples; open incidents for servers whose agent stopped pushing',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const now = Date.now()
    let overdue = 0
    for (const server of await db.selectFrom('servers').selectAll().execute()) {
      // Never heard from is not went quiet.
      if (server.status === 'unknown' || !server.last_sample_at)
        continue
      const baseline = Date.parse(server.last_sample_at)
      if (!Number.isFinite(baseline))
        continue

      const thresholds = thresholdsForServer(server)
      const { windowSeconds } = thresholds
      const isOverdue = now >= baseline + windowSeconds * 1000
      const checkedAt = new Date(now).toISOString()

      if (!isOverdue) {
        // Inside the window: the fleet is the truth. Same query as the ingest.
        const windowStart = new Date(now - windowSeconds * 1000).toISOString()
        const recent = await db.selectFrom('server_metric_samples')
          .where('server_id', '=', server.id).where('sampled_at', '>=', windowStart)
          .orderBy('sampled_at', 'desc').orderBy('id', 'desc').selectAll().execute()
        const fleet = aggregateHostStatus(readingsFromSamples(recent), now, windowSeconds)
        const status = serverStatusFromFleet(fleet)   // 'hot' | 'healthy'
        if (status !== server.status) {
          // Covers stale-hot (breaching host aged out) and widened-window
          // quiet. Compare-and-set: yield to a push that landed meanwhile.
          const res = await db.updateTable('servers').set({ status, updated_at: checkedAt })
            .where('id', '=', server.id).where('last_sample_at', '=', server.last_sample_at).execute()
          if (Number(res[0]?.numUpdatedRows ?? 0) === 0) continue
          server.status = status
        }
        await reconcileServerIncidents(server, checkedAt, fleet)
        continue
      }

      if (server.status !== 'quiet') {
        const res = await db.updateTable('servers').set({ status: 'quiet', updated_at: checkedAt })
          .where('id', '=', server.id).where('last_sample_at', '=', server.last_sample_at).execute()
        if (Number(res[0]?.numUpdatedRows ?? 0) === 0) continue   // a push just landed; it is not quiet
        server.status = 'quiet'
        log.warn(`[job] CheckStaleServers: ${server.name} stopped pushing metrics`)
      }
      // State-based: opens one server_silent if none is open, otherwise nothing.
      await reconcileServerIncidents(server, checkedAt)
      overdue++
    }
    if (overdue > 0)
      log.debug(`[job] CheckStaleServers: ${overdue} server(s) overdue`)
  },
})
```

The `numUpdatedRows` read follows the shape `@stacksjs/orm`'s own prune helper uses on this query builder (`Number(result[0]?.numDeletedRows ?? …)`); confirm the update counterpart's field name against `node_modules/bun-query-builder` when writing the job and pin it with the CAS test in §7.2.

`app/Scheduler.ts`: add `schedule.job('CheckStaleServers').everyMinute()`; in step 2 keep `CheckStaleMetrics` alongside with one change — its work-set query (`CheckStaleMetrics.ts:35`) becomes `Monitor.where('reports_metrics', true).where('enabled', true).whereNull('server_id').get()` so a migrated monitor is never double-watched; step 6 deletes the job and its schedule line. `CONSENSUS_MANAGED`, `isActivelyPolled` and `config/regions` are no longer imported by anything metrics-related.

### 4.4 Retention — `app/Jobs/PruneOldServerMetricSamples.ts` (new), scheduled `.daily()`

Same shape as `PruneOldCheckResults`: `const RETENTION_DAYS = Number(process.env.SERVER_METRIC_SAMPLE_RETENTION_DAYS) || 90`; `await ServerMetricSample.where('sampled_at', '<', cutoff).delete()` (served by the bare `sampled_at` index). Its own env var so sample retention can be tuned independently of `CHECK_RESULT_RETENTION_DAYS` — samples are one to three times probe volume. Ships in the **same** step as the table (step 1), not later.

Documentation: `.env.example` has no retention entry at all today — `CHECK_RESULT_RETENTION_DAYS` is documented only in the comment at `app/Jobs/PruneOldCheckResults.ts:15`. Add a `# Retention` block to `.env.example` directly after the consensus block (the `CONSENSUS_FRESHNESS_SECONDS` line) with **both** variables, commented out with their defaults:

```
# Retention. Daily prune jobs (PruneOldCheckResults, PruneOldServerMetricSamples)
# delete rows older than this many days. Agent samples are one to three times
# probe volume, so they get their own knob. Defaults: 90 and 90.
# CHECK_RESULT_RETENTION_DAYS=90
# SERVER_METRIC_SAMPLE_RETENTION_DAYS=90
```

### 4.5 One hot box → one incident, by construction

The token resolves to one `servers` row; there is one sample insert, one fleet aggregate over `WHERE server_id = ?`, one `servers.status` with one writer per instant within a process and a compare-and-set between processes, and one `reconcileServerIncidents` that opens a `server_hot` only when none is open. Monitors on the box do not participate in any of it, so N monitors cannot produce N incidents, `monitors.status` cannot go `degraded` because of a CPU reading, and — the production bug — no second writer can spend the ingest's recovery edge, because there is no edge: recovery is "status is healthy and something is open", evaluated on every push and every tick.

Because a breach no longer touches `monitors.status`, a box that is hot does **not** turn any monitor's pill amber, does not affect any uptime %, and does not appear on the public status page (§9.1).

### 4.6 Notification fan-out for server incidents

`app/Actions/Notifications/SendIncidentNotification.ts` and `SendIncidentResolvedNotification.ts` gain a branch at the top of `handle`:

```ts
    if (incident.server_id && !incident.monitor_id)
      return notifyServerIncident(incident, 'opened' | 'resolved')   // app/lib/serverNotifications.ts
```

`notifyServerIncident(incident, event)`:
1. `server = Server.find(incident.server_id)`; return if missing.
2. If `isServerInMaintenance(server.id, startedAtMs)` return.
3. `monitors = Monitor.where('server_id', server.id).where('team_id', server.team_id).get()` — the `team_id` predicate guards one thing: a monitor whose `server_id` was pointed at another team's box through the generated `PATCH /api/monitors/{id}` (§6.2) contributes no channels. It is **not** a defence against a forged incident — an incident carrying another team's `server_id` would fan out to exactly that team; the defence for that is that no such incident can be created or re-pointed through the API (§4.9). `attachments = MonitorNotificationChannel.whereIn('monitor_id', monitorIds).get()`.
4. `severity = incidentSeverity('', incident.impacted_checks)` — always `issue` for the two server kinds.
5. Collapse to one dispatch per `notification_channel_id`: a channel fires if **any** of its attachments `channelFiresFor(fires_on, severity)`. Three monitors routed to the same Slack channel is one Slack message.
6. Subjects: open → `⚠️ ${server.name}: box is hot` (`server_hot`) / `⚠️ ${server.name}: agent went quiet` (`server_silent`); resolved → `✅ ${server.name} has recovered`. `message = incident.cause`. `severity` field `'warning'` on open, `'info'` on resolved — never `'critical'`.
7. `monitor` context passed to `SendNotification.dispatch` is `{ id: server.id, name: server.name, url: \`${APP_URL}/dashboard/servers/${server.id}\` }` — the same field names, so no channel template changes.
8. **No** `NotifyStatusPageSubscribers.dispatch` (§9.1).

`SendIncidentNotification.ts:27` handle signature: `monitor_id: number | null, server_id?: number | null`; same for the resolved listener.

### 4.7 Other incident consumers

- `app/Actions/Incidents/AcknowledgeIncidentAction.ts:33-36`: if `incident.monitor_id` is null, verify `Server.where('id', incident.server_id).where('team_id', authTeamId).first()` instead.
- `resources/views/dashboard/incidents/index.stx:54-80` and `resources/views/dashboard/index.stx:52-82`: also fetch `teamScope(db.selectFrom('servers'))`, run a second query `db.selectFrom('incidents').whereIn('server_id', serverIds)`, merge and re-sort by `started_at` in JS (the file already avoids joins), and for server rows set `monitor_name = serverNameById.get(i.server_id) ?? 'Deleted server'` (a deleted server keeps its incident history, §6.2) and link to `/dashboard/servers/{{ incident.server_id }}` only when the server exists. `openCount` and the tally include both sets.
- `resources/views/dashboard/monitors/[id].stx:113` incident list: unchanged (monitor incidents only — §6.3). The `incidentPillClass` it defines locally at `:106-110` is lifted to `app/lib/display.ts` (§6.7) and imported.
- `resources/views/status/[slug].stx:243`, `app/Actions/StatusPages/IncidentFeedAction.ts`, `status/[slug]/incidents/[id].stx`, `NotifyStatusPageSubscribers`: all key on `monitor_id`; server incidents are excluded with zero edits.
- `app/Jobs/EvaluateMonitorConsensus.ts` `openConsensusIncident`: unchanged; it only ever looks at `monitor_id`-keyed rows with a `regions` marker.
- `app/Jobs/SendUptimeReports.ts:368-385` counts and times incidents by `monitor_id`; server incidents do not appear in the uptime report emails. Not changed here — the report is per monitor and a hot box is not a monitor event — but it is in the release note (§5), and a per-server section is a follow-up if wanted.
- `app/Actions/Monitors/DashboardDeleteMonitorAction.ts`: unchanged (server incidents are not the monitor's).

### 4.8 Existing open incidents at migration time

Resolved by the backfill (§2 phase C) with an `IncidentUpdate`, left on their monitor, never moved: the 45 open breach incidents and the 5 open quiet-agent incidents the plan counts. After that the state machine owns everything: a box still hot at migration gets a new `server_hot` on the first tick or push after phase A (its `servers.status` was backfilled `hot`, no open `server_hot` exists → open one — the tick can do this now, §4.3); a box quiet at migration gets a `server_silent` on the first tick. Neither can stack, because both open only when nothing of that kind is open. Historical `type: 'server_metrics'` markers stay classified as `issue` (§4.2) so the monitor page's incident list renders them as it always did.

### 4.9 `POST /api/incidents` and `PATCH /api/incidents/{id}` — team-checked overrides

`Incident` has no `team_id`, its `useApi` generates `store` and `update`, and `observe: true` fires `incident:created` / `incident:updated` on every write — so before this change an authenticated caller from any team could `POST /api/incidents { monitor_id: <foreign monitor>, cause: … }` and page that monitor's channels (`SendIncidentNotification.ts:28` does `Monitor.find` alone). Adding `server_id` would have doubled that surface. Both routes are overridden in `routes/api.ts`, in the existing incidents block, the same way `route.post('/monitors', …)` overrides the generated monitor store (user-defined routes take priority):

```ts
// Incident index/show are auto-generated by the `useApi` trait on
// app/Models/Incident.ts. store and update are overridden: Incident has no
// team_id of its own — its team is its monitor's or its server's — and the
// generated store/update accept any monitor_id / server_id, which through
// observe:true would page that row's team with the caller's text.
route.post('/incidents', 'Actions/Incidents/CreateIncidentAction')
route.patch('/incidents/{id}', 'Actions/Incidents/UpdateIncidentAction')
route.post('/incidents/{id}/acknowledge', 'Actions/Incidents/AcknowledgeIncidentAction')
```

`app/Actions/Incidents/CreateIncidentAction.ts`: `requireTeamId(request)` (`app/lib/teamGuard.ts`, as `CreateMonitorAction.ts:20`); read `monitor_id` and `server_id`; exactly one must be non-null, else `422 { error: 'exactly one of monitor_id or server_id is required' }`; the named row must exist in the caller's team (`Monitor.where('id', …).where('team_id', authTeamId).first()` or the same on `Server`), else `403`; then `Incident.create({ monitorId, serverId, cause, status, startedAt, impactedChecks })` from the body's remaining fillable fields. `201` with the row, as the generated store returns.

`app/Actions/Incidents/UpdateIncidentAction.ts`: `requireTeamId`; load the incident; verify its team through its `monitor_id` or `server_id` exactly as `AcknowledgeIncidentAction` does after §4.7, else `404`; if the body carries `monitor_id` or `server_id` with a value different from the row's, `422 { error: 'monitor_id and server_id cannot be changed' }`; apply the remaining fillable fields with `incident.update(...)` so `incident:updated` still fires and the resolved listener still runs for a genuine resolve.

This closes both the new server-keyed forgery and the pre-existing monitor-keyed one. `tests/feature/api-team-scoping.test.ts` gains the four cases in §7.2.

---

## 5. The agent-region voting bug

**Bug:** `app/lib/uptime.ts:199` counts `region` from every `check_results` row with no allowlist; `app/Actions/Agents/ReceiveMetricsAction.ts:85` wrote samples as `region: 'agent'`. With one probe region and `CONSENSUS_MIN_REGIONS=2` (the defaults), `consensusStatus({default:'down', agent:'up'})` clamps `required` to 2, `down=1 < 2`, `up>0` → `'up'`: 100 consecutive `down` probes with healthy pushes = 100% uptime. Same for `degraded` samples (round → degraded → counted as up), for the pill via `EvaluateMonitorConsensus.ts:105-108`'s no-configured-votes fallback, and for `RegionStatusAction.ts:56-57`.

**Fix — by construction.** Samples are written to `server_metric_samples` (§3.3) and the backfill physically moves every legacy `region='agent'` row out of `check_results` and, on its `--final` run, asserts zero remain (§2 phase E). After that, no row in `check_results` has `region='agent'`, so:

- `uptime.ts` `regionCount` drops back to the true probe-region count for every previously mixed monitor; no filter is added, none is needed.
- `EvaluateMonitorConsensus` and `RegionStatusAction` fallbacks can no longer pick an agent row.
- Readers with **no** monitor predicate become correct with zero edits: `app/Jobs/CheckWorkerHealth.ts:46` (`CheckResult.orderByDesc('checked_at').first()` — the dispatch pipeline's dead-man's switch, which a customer agent alone was keeping green) and `resources/views/dashboard/monitors/index.stx:89` `checksInRange`.
- `PruneOldCheckResults`, `DeliverCheckResultWebhooks` and `SendUptimeReports` stop seeing samples (see §9.3 for the webhook consequence).

No change to `uptime.ts`, `config/regions.ts`, `EvaluateMonitorConsensus.ts`, `RegionStatusAction.ts`. The invariant is pinned by two tests (§7.2): a push writes zero `check_results` rows, and the backfill's `--final` run asserts zero `region='agent'` rows.

**Release note** (everything a customer can see change the moment the backfill runs, none of it a regression):

1. For every monitor that had both a probe and an agent (in production, monitors 48 and 49 at least), the 90-day uptime % changes: previously masked outages appear, and `totalChecks` changes basis from rounds to rows. `SendUptimeReports` and the public page (60s cache) show the corrected number with no incident behind it.
2. The stacked and perpetual server-metrics incidents are closed with an explanatory update; new ones open under the server, one per box per kind.
3. Server incidents are not counted in uptime report emails (they are not monitor incidents).
4. Host telemetry moves from the monitor page to the server page; the monitor page shows the box's current reading in its Server card.
5. The ingest response's `status` field is the server's (`healthy` / `hot`); `sampleStatus` is unchanged.
6. Per-sample webhooks stop (§9.3).
7. `POST /api/incidents` now requires exactly one of `monitor_id` / `server_id`, in the caller's team; `PATCH /api/incidents/{id}` no longer accepts a change to either (§4.9).

---

## 6. UI

Read first: `app/Models/MonitorNotificationChannel.ts`, `app/lib/notificationSeverity.ts`, and `resources/views/dashboard/monitors/[id].stx:120-146` (data), `:782-840` (`.alert-empty`, `#alerts-dialog`, `.dlg-*` CSS), `:1329-1444` (Alert routing card + `#alerts-dialog`), `:1780-1815` (open/close script). The pattern: **the card shows the answer, the dialog holds the form**; one button opens one `<dialog>`; a plain `<form method="POST">` to a `/api/*-forms/*` route; the action reconciles and 302s back with a `?flag=1` query the page turns into a `.flash`.

### 6.1 Routes (`routes/api.ts`, new block under the monitor-forms block)

```ts
// Server form posts. Same /*-forms/ prefix (dashboard/servers/[id].stx would
// collide with /dashboard/servers/*). Every action is team-scoped through
// servers.team_id and, where a monitor is named, monitors.team_id too.
// There is deliberately no generated PATCH/DELETE /servers/{id}: the
// generated update filters by `fillable` alone and the generated destroy
// deletes only the row (Server.ts useApi comment).
route.post('/servers', 'Actions/Servers/CreateServerAction')                                  // JSON; mints the token (hidden:true)
route.post('/server-forms/create', 'Actions/Servers/DashboardCreateServerAction')
route.post('/server-forms/{serverId}/update', 'Actions/Servers/DashboardUpdateServerAction')
route.post('/server-forms/{serverId}/delete', 'Actions/Servers/DashboardDeleteServerAction')
route.post('/server-forms/{serverId}/rotate-token', 'Actions/Servers/DashboardRotateServerTokenAction')
route.post('/server-forms/{serverId}/monitors', 'Actions/Servers/DashboardSaveServerMonitorsAction')   // server page: multi-select
route.post('/server-forms/monitors/{monitorId}/server', 'Actions/Servers/DashboardAttachServerAction') // monitor page: one server
```

The incident overrides of §4.9 go in the existing incidents block, not here.

### 6.2 Actions (`app/Actions/Servers/`)

All begin with `requireTeamId(request)` exactly as `DashboardSaveRoutingAction` does. Shared parsing in `app/lib/serverForm.ts`:

```ts
export interface ServerFormInput { name?: unknown, cpu_threshold?: unknown, ram_threshold?: unknown, disk_threshold?: unknown, metrics_window_seconds?: unknown }
export interface ServerFormResult { values: { name: string, cpu_threshold: number, ram_threshold: number, disk_threshold: number, metrics_window_seconds: number }, error: string | null }
export function parseServerForm(input: ServerFormInput): ServerFormResult
// name: trimmed, required, <=150 -> 'name_required' | 'name_too_long'
// thresholds: intInRange(0..100) (reuse monitorForm's intInRange), blank -> 90/90/85
// window: intInRange(30..86400), blank -> 300; below 30 -> 'window_invalid'
// Never reads status or last_sample_at: those are not form fields anywhere.
```

| Action | Input | Behaviour | Redirect |
|---|---|---|---|
| `CreateServerAction` (JSON) | `name`, thresholds, window; optional `team_id` must equal auth team (copy `CreateMonitorAction.ts:24-26`) | `Server.create({ teamId, ..., metricsToken: randomUUIDv7().replace(/-/g, '') })` — `status` takes the column default `'unknown'`, `lastSampleAt` stays null | `201` JSON (token hidden) |
| `DashboardCreateServerAction` | form fields + optional `attach_monitor_id` | create as above; if `attach_monitor_id` names a monitor in this team, `monitor.update({ server_id })` | `/dashboard/monitors/{id}?server=1` when attaching, else `/dashboard/servers/{id}?created=1` |
| `DashboardUpdateServerAction` | `serverId`, form fields | team-scoped fetch → 403; `server.update(values)` (name, thresholds, window only). Widening the window on a `quiet` server leaves it `quiet` with its `server_silent` open until the next `CheckStaleServers` tick, which recomputes the status from the now-in-window samples and resolves the incident (§4.3); the page's flash says "Saved. Status re-evaluates within a minute." | `/dashboard/servers/{id}?saved=1` |
| `DashboardDeleteServerAction` | `serverId` | team-scoped fetch → 403; then in **one** `transaction(async (tx) => …)` (`@stacksjs/orm`), query builder only: `tx.updateTable('monitors').set({ server_id: null }).where('server_id', '=', id)`; for every open incident with `server_id = id`, `tx.updateTable('incidents').set({ status: 'resolved', resolved_at })` and `tx.insertInto('incident_updates')` one row ("Server deleted.", `status: 'resolved'`, `posted_at`); `tx.deleteFrom('server_metric_samples').where('server_id', '=', id)`; `tx.deleteFrom('servers').where('id', '=', id)`. Because these are query-builder writes, `incident:updated` does not fire and no "has recovered" notification goes out for a box the operator just deleted — intended. Incident rows are kept as history (their `server_id` now points at nothing; the incidents index renders "Deleted server"). | `/dashboard/servers?deleted=1` |
| `DashboardRotateServerTokenAction` | `serverId` | `server.update({ metrics_token: randomUUIDv7().replace(/-/g, '') })` — the installed agent breaks until re-run; the page says so | `/dashboard/servers/{id}?rotated=1` |
| `DashboardSaveServerMonitorsAction` | `serverId`, `mon_<monitorId>=1` per checked row | For each team monitor: checked → `server_id = serverId` (moving it off any other server); unchecked and currently on this server → `server_id = null`. Absence means detach, reconciled against the team's monitor list (the `DashboardSaveRoutingAction` shape). | `/dashboard/servers/{id}?monitors=1` |
| `DashboardAttachServerAction` | `monitorId`, `server_id` (`''` = detach) | team-scoped monitor and, if non-empty, team-scoped server → 403; `monitor.update({ server_id })` | `/dashboard/monitors/{id}?server=1` |

Both attach directions write the same column with the same check; there is no pivot.

**Monitor actions — shipped in step 2 (§0.13), before the backfill:** `CreateMonitorAction` (`:60-63`), `DashboardCreateMonitorAction` (`:84`) and `DashboardUpdateMonitorAction` (`:84-89`) drop `reports_metrics`, `cpu_threshold`, `ram_threshold`, `disk_threshold` and every `metrics_token` mint; gain `server_id` (empty → null; non-empty → must be a server in the auth team, else 403 for the form / `{error}` 422 for JSON). `CreateMonitorAction` returns `422 { error: 'reports_metrics has moved: create a server with POST /api/servers and pass server_id' }` if `reports_metrics` is present, rather than silently ignoring a field that used to mint a credential. `app/lib/monitorForm.ts`: remove `reports_metrics`/`cpu_threshold`/`ram_threshold`/`disk_threshold` from `MonitorFormInput`, `reports_metrics` from `MonitorFormResult.values` and the `fail()` literal, the gated block at `:256-267`, and the third parameter: `buildMonitorConfig(type, input)`. `DashboardUpdateMonitorAction` must not touch an existing `monitors.metrics_token` either way (it never cleared one before; it now never sets one). The `reports_metrics` and `metrics_token` **columns** stay until step 6 and are simply never written after step 2 — that is what makes phase B's population fixed and the `--final` sweep complete.

Auto-CRUD note: `PATCH /api/monitors/{id}` can now carry `server_id` and the generated update does not check that the server is in the caller's team. The defence is on read: every place that renders server data for a monitor (§6.3, §6.6) joins `servers.team_id = monitor.team_id`, so a mismatched `server_id` renders as detached and leaks nothing, and the notification fan-out filters monitors by the server's team (§4.6 step 3). Add the case to `tests/feature/api-team-scoping.test.ts`.

### 6.3 Monitor detail page — the Server card (`resources/views/dashboard/monitors/[id].stx`)

**Delete:** the `parseMetricsThresholds`/`aggregateHostStatus`/`readingsFromRows` imports (`:38-39`, keep `DEFAULT_HOST` only if still used); `hostChart`/`__hostRows` compute (`:466-566`) and the dead `avg_cpu`/`avg_ram` accumulation in the volume buckets (`:400-412`, keep `request_count`); `__agentInstall` (`:672-682`); the Host telemetry, Hosts and Agent setup cards (`:961-1043`); the `edit-metrics`/`edit-cpu`/`edit-ram`/`edit-disk` fields (`:1673-1693`) and the sentence about them in the gating-script comment (`:1740-1742`); the `cfgValue('cpuThreshold')` calls; the local `incidentPillClass` (`:106-110`, replaced by the `display.ts` import). Keep `.code-block` CSS (`:766-776`, the heartbeat card uses it).

**Server block (data), placed with the Alert routing data:**

```js
// Server card: the box this site runs on. Joined on team_id as well as id
// so a server_id pointing at another team's box (auto-CRUD update has no
// ownership check on the column) renders as detached and shows nothing.
let serverCard = null           // display projection only — never the raw row
let serverSuggestion = null
let teamServers = []            // [{ id, name }] for the dialog
if (monitor) {
  const rows = await db.selectFrom('servers').where('team_id', '=', monitor.team_id).orderBy('name', 'asc').execute()
  teamServers = rows.map(s => ({ id: s.id, name: s.name }))
  const srv = monitor.server_id ? rows.find(s => s.id === monitor.server_id) : null
  if (srv) {
    const th = thresholdsForServer(srv)
    const windowStart = new Date(Date.now() - th.windowSeconds * 1000).toISOString()
    const recent = await db.selectFrom('server_metric_samples').where('server_id', '=', srv.id).where('sampled_at', '>=', windowStart).orderBy('sampled_at', 'desc').execute()
    const fleet = aggregateHostStatus(readingsFromSamples(recent), Date.now(), th.windowSeconds)
    const worst = key => fleet.hosts.reduce((m, h) => h[key] !== null && (m === null || h[key] > m) ? h[key] : m, null)
    const siblings = await db.selectFrom('monitors').where('server_id', '=', srv.id).where('id', '!=', monitor.id).select(['id', 'name']).execute()
    serverCard = {
      id: srv.id, name: srv.name, status: srv.status,
      pill: serverStatusPill(srv.status),                    // app/lib/display.ts, §6.7
      hosts: fleet.hosts.length,
      cpu: { value: worst('cpuPercent'), limit: th.cpu }, ram: { value: worst('ramPercent'), limit: th.ram }, disk: { value: worst('diskPercent'), limit: th.disk },
      lastSample: agoLabel(srv.last_sample_at),
      siblings: siblings.map(s => ({ id: s.id, name: s.name })),
    }
  }
  else {
    serverSuggestion = await suggestServerForMonitor(monitor, rows)   // §6.4
  }
}
```

**Card (placed directly above the Alert routing card):**

```html
<section class="card" aria-label="Server">
  <div class="card-head">
    <h3>Server</h3>
    @if (serverCard)
      <span class="sub"><span class="{{ serverCard.pill.cls }}"><span class="dot"></span>{{ serverCard.pill.label }}</span></span>
    @else
      <span class="sub">Not on a tracked server</span>
    @endif
  </div>
  @if (serverSaved)<div class="card-body" style="padding-bottom: 0;"><div class="flash">Server saved.</div></div>@endif

  @if (serverCard)
    <div class="rows">
      <div class="trow" style="grid-template-columns: minmax(0, 1fr) auto;">
        <span class="tcell ellipsis"><StxLink class="name" to="/dashboard/servers/{{ serverCard.id }}">{{ serverCard.name }}</StxLink>
          @if (serverCard.hosts > 1)<span class="sub" style="margin-left: 0.5rem;">{{ serverCard.hosts }} hosts</span>@endif</span>
        <span class="tcell sub">last sample {{ serverCard.lastSample }}</span>
      </div>
      {{-- one .trow per metric: label, "62% of 90%", amber when value >= limit (limit 0 = "off") --}}
      @foreach ([['CPU', serverCard.cpu], ['Memory', serverCard.ram], ['Disk', serverCard.disk]] as m)
        <div class="trow metric-row {{ m[1].value !== null && m[1].limit > 0 && m[1].value >= m[1].limit ? 'is-hot' : '' }}" style="grid-template-columns: 90px minmax(0, 1fr) auto;">
          <span class="tcell">{{ m[0] }}</span>
          <span class="tcell"><span class="meter"><span class="meter-fill" style="width: {{ m[1].value === null ? 0 : Math.min(100, m[1].value) }}%;"></span></span></span>
          <span class="tcell mono">{{ m[1].value === null ? '--' : Math.round(m[1].value) + '%' }} <span class="sub">of {{ m[1].limit > 0 ? m[1].limit + '%' : 'off' }}</span></span>
        </div>
      @endforeach
    </div>
    <div class="card-body alert-foot">
      <p class="help">
        @if (serverCard.siblings.length === 0)No other monitors on this box.
        @else {{ serverCard.siblings.length }} other monitor{{ serverCard.siblings.length === 1 ? '' : 's' }} on this box:
          @foreach (serverCard.siblings as s)<StxLink to="/dashboard/monitors/{{ s.id }}">{{ s.name }}</StxLink>{{ loop.last ? '' : ', ' }}@endforeach
        @endif
      </p>
      <button type="button" class="button" id="server-open">Change server</button>
    </div>
  @else
    <div class="card-body">
      <div class="alert-empty">   {{-- NEUTRAL: dashed, --surface-2, NOT .is-danger. No agent on a third-party API is normal. --}}
        <p><strong>No server attached.</strong>
          @if (serverSuggestion)<span class="mono">{{ serverSuggestion.host }}</span> resolves to the same host as <strong>{{ serverSuggestion.name }}</strong> — attach?
          @else Attach one to see this box's CPU, memory and disk here, or leave it if nothing you run pushes metrics for this site.@endif
        </p>
        @if (serverSuggestion)
          <form method="POST" action="/api/server-forms/monitors/{{ monitor.id }}/server"><input type="hidden" name="server_id" value="{{ serverSuggestion.id }}" /><button type="submit" class="button sm primary">Attach {{ serverSuggestion.name }}</button></form>
        @endif
        <button type="button" class="button sm {{ serverSuggestion ? '' : 'primary' }}" id="server-open">{{ serverSuggestion ? 'Choose another' : 'Attach a server' }}</button>
      </div>
    </div>
  @endif
</section>
```

`.metric-row.is-hot .tcell.mono { color: var(--amber); }` and `.metric-row.is-hot .meter-fill { background: var(--amber); }`; `.meter` is a 6px `--surface-2` bar with a `--accent` fill. Never `--danger` here. This card is the **only** place a breach appears on a monitor page — no banner.

**Dialog `#server-dialog`** (copy `#alerts-dialog` CSS with the id swapped; same open/close script by ids `server-open` / `server-close` / `server-cancel`, wording written around binding names — no `serverCard`, `teamServers`, `monitor` in script text or comments):

```html
<dialog id="server-dialog" aria-labelledby="server-dialog-title">
  <header class="dlg-head"><div><h3 id="server-dialog-title">Server</h3><p class="sub">Which box does this site run on?</p></div>
    <button type="button" class="dlg-x" id="server-close" aria-label="Close">…</button></header>
  <div class="dlg-body" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem;">
    <form method="POST" action="/api/server-forms/monitors/{{ monitor.id }}/server">
      <h4>Attach to an existing server</h4>
      <select name="server_id" class="select" aria-label="Server">
        <option value="">Not on a tracked server</option>
        @foreach (teamServers as s)<option value="{{ s.id }}" {{ serverCard && serverCard.id === s.id ? 'selected' : '' }}>{{ s.name }}</option>@endforeach
      </select>
      @if (teamServers.length === 0)<p class="help">Your team has no servers yet.</p>@endif
      <button type="submit" class="button primary" style="margin-top: 0.85rem;">Attach</button>
    </form>
    <form method="POST" action="/api/server-forms/create">
      <h4>Create a new server</h4>
      <input type="hidden" name="attach_monitor_id" value="{{ monitor.id }}" />
      <label for="srv-name">Name</label>
      <input id="srv-name" name="name" class="input" value="{{ monitorSiteHost }}" maxlength="150" />
      <p class="help">Thresholds start at CPU 90 / memory 90 / disk 85, window 300s. Edit them on the server page. Nothing alerts until the agent's first push.</p>
      <button type="submit" class="button primary" style="margin-top: 0.85rem;">Create and attach</button>
    </form>
  </div>
  <footer class="dlg-foot"><button type="button" class="button" id="server-cancel">Cancel</button></footer>
</dialog>
```

Prefill is `monitorSiteHost` (`siteHost(monitor.url)`, already computed at `:85`). `serverSaved = query.get('server') === '1'`. "Nothing alerts until the agent's first push" is true because the new server is `unknown` and `CheckStaleServers` skips `unknown` (§4.3).

`monitors/new.stx`: delete the Server metrics card (`:305-333`); add one field to the main form: `<select name="server_id">` with "Not on a tracked server" + the team's servers (`db.selectFrom('servers').where('team_id', ...)`); no create-new here (the detail-page dialog does that after save, which is how the token snippet always worked).

### 6.4 Hostname suggestion — `app/lib/serverSuggestion.ts`

Suggestion only; never membership.

```ts
/** Candidate hosts a server is known by: its name plus every host its agent has reported in the last 7 days. */
export async function knownHostsForServers(serverIds: number[]): Promise<Map<number, Set<string>>>
//   SELECT DISTINCT server_id, host FROM server_metric_samples WHERE server_id IN (...) AND sampled_at >= now-7d
//   'default' is dropped — it identifies nothing (monitors 48/49's agents send it).

/** The first server whose known host matches the monitor's URL host, or null. */
export async function suggestServerForMonitor(monitor: { url: string }, servers: { id: number, name: string }[]): Promise<{ id: number, name: string, host: string } | null>
//   host = normalizeHost(siteHost(monitor.url)); if host === 'default' return null
//   match(a, b): a === b || firstLabel(a) === firstLabel(b) where firstLabel = s.split('.')[0]  (web-01 vs web-01.example.com)
//   candidates = server.name normalised + knownHosts; first match by servers order (name asc)
```

String matching only — no DNS: the suggestion renders inside a page and cannot block on resolution. `firstLabel` matching is what makes an agent reporting `web-01` match a monitor on `https://web-01.example.com`. Monitors 48 and 49's agents report `host = 'default'` (their installer predates the field), so for those boxes the suggestion can only match on the server *name*, which the backfill sets to the monitor name; the four orphan-token monitors on the shared box are attached by hand (§2 phase B).

### 6.5 Server pages

**`resources/views/dashboard/servers/index.stx`** (`NAV_ACTIVE = 'servers'`): team-scoped list — name (link), status pill (§6.7), worst CPU/RAM/disk now (same `worst()` as the card, from a single windowed samples query grouped by `server_id` in JS), last sample age, "N monitors". "Add a server" button → `#server-create-dialog` (name + thresholds + window, `POST /api/server-forms/create`). Empty state (neutral, dashed): "No servers yet. A server is a box that pushes CPU, memory and disk to StatusHQ; attach the monitors that run on it."

**`resources/views/dashboard/servers/[id].stx`** — the page that owns metric history, incidents and the monitor list. Team-scoped fetch (`TEAM_ID = -1` on auth failure, as `monitors/[id].stx`). Raw row bound as `__serverRow`; everything the template reads comes from a projected `serverView` without the token. Sections, top to bottom:

1. **Header**: breadcrumb `← All servers`, `<h1>{{ name }}</h1>`, meta `{{ monitorCount }} monitors · last sample {{ ago }} · window {{ w }}s`, status pill.
2. **Band** (only when an open server incident exists) — the ONE place a breach or silence is rendered:
   ```html
   <div class="server-band">  {{-- border: 1px solid var(--amber); background: var(--amber-soft); never --danger --}}
     <strong>{{ band.title }}</strong> <span>{{ band.cause }}</span> <span class="sub">since {{ band.since }}</span>
     <div class="blast">  {{-- "N monitors on this server", each with ITS OWN up/down pill via statusPillClass --}}
       <p class="sub">{{ monitors.length }} monitor{{ monitors.length === 1 ? '' : 's' }} on this server</p>
       @foreach (monitors as m)<StxLink to="/dashboard/monitors/{{ m.id }}"><span class="{{ m.pill }}"><span class="dot"></span>{{ m.statusLabel }}</span> {{ m.name }}</StxLink>@endforeach
     </div>
   </div>
   ```
   `band.title` = `Box is hot` (`server_hot`) / `Agent went quiet` (`server_silent`); when both are open (a box that was hot and then went silent) render two bands, quiet first. The monitors' own pills may be red — that red is theirs (site down), the band is amber.
3. **Monitors on this server** card: rows of attached monitors (name, type, own status pill, uptime link) or neutral empty state "No monitors attached yet"; footer button `Manage monitors` → `#monitors-dialog`: the routing-grid shape — one checkbox row per **team** monitor (`mon_<id>`), rows currently on another server show `(on <other server>)` and moving them is allowed; submit `POST /api/server-forms/{id}/monitors`.
4. **Host telemetry** card — the chart moved verbatim from `monitors/[id].stx:466-566` + `:961-994`, sourced from `db.selectFrom('server_metric_samples').where('server_id', …).where('sampled_at', '>=', since).orderBy('sampled_at','asc')` with typed columns (`r.cpu_percent`, no `JSON.parse`), `?range=24h|7d|30d` as today, per-host: `?host=<name>` selects the series, default the most recently reporting host, "showing {{ host }}" legend.
5. **Hosts** card — moved from `:996-1019`, from `aggregateHostStatus(readingsFromSamples(windowed rows))`.
6. **Thresholds** card (answer): `CPU alerts at 90% · Memory at 90% · Disk at 85% · Missed-push window 300s` with "off" for 0; footer `Edit thresholds` → `#thresholds-dialog` (four number inputs + window, `POST /api/server-forms/{id}/update`; the window has a UI for the first time, help: "Keep the agent's interval under this or the box alerts between pushes"). `?saved=1` flash: "Saved. Status re-evaluates within a minute."
7. **Agent setup** card — moved verbatim from `:1021-1043`, built on `__agentInstall` from `__serverRow.metrics_token` exactly as today (`:675-682`), plus a `Rotate token` button (`POST /api/server-forms/{id}/rotate-token`, `confirm()`), which makes the card's "that is also how you rotate the token" sentence true. When `status === 'unknown'` the card leads with "Waiting for the first sample" so the operator knows the box is not being watched yet.
8. **Incidents** — server incidents (`WHERE server_id = ?`), pill via `incidentPillClass(incident, '')` (§6.7) → amber for both kinds; each incident's `IncidentUpdate`s beneath it, so a breach set that changed in place reads as a timeline.
9. **Danger zone**: rename (in the thresholds dialog), delete (`POST /api/server-forms/{id}/delete`, confirm; copy: "Detaches N monitors, deletes M samples and closes the box's open incidents. Monitors and incident history are kept.").

`resources/views/partials/app-nav.stx`: add `<StxLink to="/dashboard/servers" class="{{ NAV_ACTIVE === 'servers' ? 'active' : '' }}">Servers</StxLink>` after Monitors; extend the `NAV_ACTIVE` union in the comment at `:5`. Breadcrumb on `monitors/[id].stx:861` gains ` · <StxLink to="/dashboard/servers/{{ serverCard.id }}">{{ serverCard.name }}</StxLink>` when attached.

### 6.6 Site page (`resources/views/dashboard/sites/[slug].stx:89-142, :229-260`)

Replace `siteMonitors.find(m => m.reports_metrics)` (`:91`) with the distinct `server_id`s of `siteMonitors` joined to `servers` on `team_id`; render one telemetry card **per server** (a site can span boxes), sourced from `server_metric_samples` with the same per-host selection as the server page (newest host), and point "Full telemetry →" at `/dashboard/servers/{{ id }}`.

### 6.7 `app/lib/display.ts` additions

```ts
/** Server status pill. 'quiet' (agent silent) is amber, not red: --danger is for a site being down. */
export function serverStatusPill(status: string | null | undefined): { cls: string, label: string } {
  if (status === 'healthy') return { cls: 'pill pill-up', label: 'Reporting' }
  if (status === 'hot') return { cls: 'pill pill-degraded', label: 'Hot' }
  if (status === 'quiet') return { cls: 'pill pill-degraded', label: 'Quiet' }
  return { cls: 'pill pill-unknown', label: 'No samples yet' }
}

/**
 * Lifted from monitors/[id].stx (where it was a local function) so the
 * server page and the incidents index classify the same way. An open issue
 * reads amber whatever its workflow state; painting "a host crossed 51%
 * against a 50% CPU threshold" in the red reserved for "this site is
 * unreachable" is the over-alarming the severity split exists to stop.
 */
export function incidentPillClass(incident: { resolved_at?: string | null, status?: string | null, impacted_checks?: string | null }, monitorType = ''): string {
  if (incident.resolved_at || incident.status === 'resolved') return 'pill pill-unknown'
  if (incident.status === 'monitoring') return 'pill pill-degraded'
  if (incidentSeverity(monitorType, incident.impacted_checks) === 'issue') return 'pill pill-degraded'
  return 'pill pill-down'
}
```

`monitors/[id].stx` imports it and passes `monitor ? monitor.type : ''`.

### 6.8 Bridge hygiene (hard rule, enforced by `tests/unit/bridge-hygiene.test.ts`)

Raw `servers` rows carry `metrics_token`. In every new/edited view: bind raw rows only as `__`-prefixed names (`__serverRow`, `__serverRows`), project to display fields before any un-prefixed binding, keep `__agentInstall` as the only token-bearing binding, find every dialog element by id, and write script prose around the binding names (`serverView`, `teamServers`, `serverCard` must not appear in any plain `<script>` text). `monitors/index.stx:96-105` and `maintenance/[id].stx:58` comments that mention `metrics_token` on monitor rows: update to say the credential now lives on `servers` rows and the projection rule is unchanged.

### 6.9 Docs and marketing copy

`docs/monitors/server-metrics.md` — every paragraph below is false after this change and is rewritten; the payload, installer options, "Checking it works", "Requirements" and "Rolling your own" sections stay verbatim:
- `:13` "Every sample is recorded as a check result, so it charts per host and feeds the same history and uptime machinery as any other monitor" → samples are host telemetry on the server, charted on the server page, and never enter uptime; "the token appears on the monitor page once you enable metrics" → the token is on the server page.
- `:30-36` "Several machines, one monitor" → "Several machines, one server": the Hosts card and the fleet rule move to the server page; "The monitor's status is then the fleet's" → the *server's* status is (`healthy` / `hot` / `quiet`); "a host that stops pushing entirely does both [costs uptime and pages down-only channels]" → a quiet agent is an issue on the server, costs no uptime and never pages the down-only channels.
- `:41-43` "What triggers an alert": thresholds are server fields, both alerts are issues, the missed-push window is a server field with a UI; delete "Thresholds and the missed-push window live in the monitor's config (…)".
- "Setting it up": create a server (from the monitor's Server card or the Servers page), attach the monitors that run on it, copy the installer command from the server's Agent setup card. Installer table row `--interval`: "below the **server's** missed-push window".

`resources/views/features/server-monitoring.stx:94` promises the CPU and memory history "on the same screen" as the incident — telemetry now lives on the server page one click from the monitor's Server card; reword to "one click away, with the incident". (The "toggle on any monitor" phrase the previous draft named does not occur in that file.) `docs/index.md:93` and `docs/monitors/index.md:39` copy still fits.

### 6.10 Live updates

`broadcastMonitorUpdate` returns unless Redis broadcasting is enabled (`app/Realtime/broadcastMonitorUpdate.ts:12-16`), and the `buddy realtime` poller fires only on `monitors.status` / `last_checked_at` changes (`app/Commands/Realtime.ts:35-36`) — columns the new ingest never writes. Even on Redis, a nudge from the ingest would broadcast an unchanged monitor status. So the ingest and `CheckStaleServers` do **not** call it, and the Server card and server pages update on reload (or the dashboard's own periodic refresh), not live. Extending the poller's snapshot to `servers` is a follow-up, not part of this change.

---

## 7. Test plan

Run with `buddy test` (Bun). Feature tests build fixtures with inline `Monitor.create({...})`; there are no factories, so each listed file is edited by hand. Where a fixture needs a non-default `status` or `last_sample_at` on a server, insert with `db.insertInto('servers')` (the attributes are not fillable) — `makeServer` in `tests/feature/server-metrics.test.ts` does this.

### 7.1 Breaks → repoint

| File | What breaks | Change |
|---|---|---|
| `tests/feature/server-metrics.test.ts` | `makeMetricsMonitor` puts `metricsToken`/`reportsMetrics`/config on Monitor (10 of 12 tests 404; thresholds test also fails on defaults; missed-push test re-reads `Monitor.find(id).metrics_token`) | Helper becomes `makeServer(overrides)` → `db.insertInto('servers').values({ team_id: TEAM, name, metrics_token: token, cpu_threshold, ram_threshold, disk_threshold, metrics_window_seconds, status: overrides.status ?? 'unknown', last_sample_at: overrides.last_sample_at ?? null, uuid })` plus one `Monitor.create({ teamId: TEAM, serverId: server.id, type: 'uptime', status: 'up', ... })`. `statusOf` reads `servers.status`; `openIncidents` filters `where('server_id','=',id)`; the stale test calls `CheckStaleServers.handle()` with a fixture whose `status` is `'healthy'` and `last_sample_at` is older than the window; teardown deletes `incident_updates`, `incidents where server_id`, `server_metric_samples`, monitors, servers. `TEAM = 90600` stays a bare integer. Expected statuses become `'healthy'` / `'hot'` / `'quiet'`. The vacuous `expect(statusOf).toBe('up')` in the recent-push test becomes `expect(await statusOf(id)).toBe('healthy')` **and** `expect(openIncidents).toHaveLength(0)`. The `:107-108` comment quoting a production incident count is deleted with the fixture it explains. |
| `tests/feature/monitor-dashboard-forms.test.ts:173-189` | raw SELECT of `monitors.metrics_token` throws; `config toEqual({cpuThreshold:80})` fails | Delete this test; its two intents move to `server-forms.test.ts` ("create mints once", "update keeps the token"). Add "the form accepts `server_id` for a team server and 403s for another team's". |
| `tests/feature/monitor-crud.test.ts:207-232` | `metrics_token` undefined | Replace with: `reports_metrics` → 422 with the migration message; `server_id` of a team server accepted; other team's `server_id` → 403; new `server-crud.test.ts` for `POST /api/servers` (token > 16 chars via raw select, absent from the response body; `PATCH` and `DELETE /api/servers/{id}` → 404/405, the routes are not generated). |
| `tests/feature/check-dispatch.test.ts:122-179` | both push with a Monitor token | First test: fixture becomes Server + attached Monitor; keep `expect(pushed.status).toBe(200)` and `probed.length > 0` (probed = all `check_results` rows now — no `region !== 'agent'` filter). Second test **deleted** (the ingest no longer writes any monitor clock) and replaced by "an agent push leaves `monitors.status` and `monitors.last_checked_at` untouched" (same fixture, assert both equal the pre-push values). |
| `tests/feature/notification-severity-routing.test.ts:111-158` | fixtures `reportsMetrics: true`; incidents monitor-keyed; the silent test's fixture uses `type: 'missed_push'`, a shape nothing in the app writes | Server + monitor fixtures; incidents passed with `server_id: server.id, monitor_id: null`. Breach test: `impacted_checks: [{ type: 'server_hot', hosts: [{ host: 'web-01', breaches: ['CPU 51% ≥ 50%'] }] }]` → issue channels only. Silent test renamed "a server whose agent went quiet is an issue, not an outage": `impacted_checks: [{ type: 'server_silent', reason: 'missed_push', windowSeconds: 300 }]` → `expect(to).toContain('issue@example.com')`, `expect(to).not.toContain('down@example.com')`. Add "three monitors routed to one channel → one dispatch" and "a monitor from another team pointing at this server contributes no channels". Line 209's `teamId + 9999` IDOR test unaffected (no server). |
| `tests/feature/metrics-consensus-ownership.test.ts` | nothing in step 2 — it never invokes `CheckStaleMetrics` (the name appears only in comments at `:16,20,98`); it writes `METRICS_IMPACT` via `openIncident` directly (`:102-114`) and drives `EvaluateMonitorConsensus.handle` | No fixture change in step 2. In step 6 optionally retarget `METRICS_IMPACT` (`:36`) to the `server_silent` marker and the docblock to `CheckStaleServers`; the ownership predicate tests are unchanged either way. |
| `tests/unit/agent-snippet.test.ts:18, :110` | `VIEW` reads `monitors/[id].stx`; the `:110` regex targets `monitor.metrics_token`, which can never match on the server page, so the test would pass vacuously | Point `VIEW` at `resources/views/dashboard/servers/[id].stx`; change the regex to `/^(?!.*__agentInstall).*\{\{\s*__serverRow\.metrics_token\s*\}\}/m` so the token is still only ever rendered through `__agentInstall`. |
| `tests/unit/monitor-form.test.ts:174-178` | the three-arg `buildMonitorConfig(type, input, reportsMetrics)` calls and the "metric thresholds only when the host reports metrics" case | Drop the third argument everywhere in the file and delete that case. `tests/unit/monitor-form-wiring.test.ts` has no threshold wiring (its OWNERS table at `:108-124` lists none) and is unaffected. Ships with step 2 (§6.2). |
| `tests/unit/bridge-hygiene.test.ts` | nothing to change — it scans every `.stx`, so the new views are covered automatically | — |
| `tests/unit/agent-hosts.test.ts` | unaffected | Add `readingsFromSamples` cases mirroring `readingsFromRows` (breaches → degraded, bad `sampled_at` skipped, `breaches` malformed → `[]`) and `serverStatusFromFleet` (degraded → hot, up → healthy). |
| `tests/unit/uptime.test.ts` | unaffected | — (the voting invariant is a feature test, §7.2, because after the split there are no agent rows for a unit test to exclude) |

### 7.2 New tests

- `tests/feature/server-forms.test.ts`: create (mint, hidden), update thresholds/window (30 floor; posting `status` or `last_sample_at` changes nothing), rotate (token changes, old 404s, new 200s), delete (monitors detached not deleted; samples gone; open incidents resolved with an `IncidentUpdate` row, rows kept; **no** notification dispatched for the resolve), save-monitors grid (attach, detach by absence, move from another server), attach-from-monitor (`''` detaches; other team's server 403; other team's monitor 403).
- `tests/feature/server-incidents.test.ts` — the state machine:
  - one server, three attached monitors, one breaching push → exactly one incident, marker `server_hot`, `server_id` set, `monitor_id` null, none of the three monitors' `status` changed; second breaching push with the same breach set → still one, no `IncidentUpdate`; a push where a second host breaches → still one, cause and marker updated, one `IncidentUpdate`; healthy push → resolved with one `IncidentUpdate`.
  - state not edge (push): fixture server `status: 'healthy'` with an open `server_hot` inserted directly (the post-migration shape) → a healthy push resolves it.
  - state not edge (tick): fixture server `status: 'hot'`, `last_sample_at` inside the window, one breaching sample inside the window, **no** open incident (the post-backfill / crashed-ingest shape) → `CheckStaleServers` opens exactly one `server_hot`; a second tick opens nothing; a tick after a second host's breaching sample is inserted updates the marker in place with one `IncidentUpdate`.
  - stale-hot self-heal: `status: 'hot'`, the breaching host's sample older than the window, a healthy host's sample inside it with `last_sample_at` matching → tick writes `healthy` and resolves the open `server_hot`.
  - widened window: `status: 'quiet'`, open `server_silent`, `last_sample_at` 4 minutes old, `metrics_window_seconds` 600 (as after `DashboardUpdateServerAction`) → tick sets `healthy`/`hot` from the samples and resolves the `server_silent`.
  - compare-and-set: `status: 'healthy'`, `last_sample_at` older than the window; between the job's read and its write (monkey-patch or a pre-update hook that inserts a fresh push and bumps `last_sample_at`) → the tick's UPDATE matches zero rows, status stays what the push wrote, no `server_silent` opened.
  - hot → quiet → hot does not stack: breaching push; `last_sample_at` aged past the window; `CheckStaleServers` → status `quiet`, one `server_silent`, the `server_hot` still open; breaching push → `server_silent` resolved, still exactly one `server_hot`.
  - quiet: `CheckStaleServers` twice → one `server_silent`; next push resolves it and status leaves `'quiet'`.
  - never-heard-from: server `status: 'unknown'`, `last_sample_at: null`, `created_at` an hour ago → `CheckStaleServers` opens nothing and leaves status `'unknown'`.
  - maintenance: all monitors in a window → suppressed, one of two → not suppressed.
- `tests/feature/servers-backfill.test.ts` — the plan's four rules: fixture — monitor A (`reports_metrics = 1`, token `tokA`, `config {cpuThreshold:50, metricsWindowSeconds:120}`, 5 `region='agent'` rows: three normal, one without numeric metrics and the newest of all, one legacy `status:'down'` without a `breaches` array; 3 probe rows; one open breach incident and one resolved missed-push incident); monitor B (`reports_metrics = 1`, token `tokB`, zero agent rows, one open missed-push incident); monitor C (`reports_metrics = 0`, token `tokC`, 2 agent rows). Run `servers:backfill`, then again with `--final`. Assert: servers for `tokA` and `tokC` only, same token values, A's thresholds 50/90/85/120; A and C have `server_id`; B has `server_id NULL`, `metrics_token NULL`, `reports_metrics 0`; A's server `last_sample_at` = the metric-less row's `checked_at`; 4 samples for A (the legacy `down` row carries `breaches: ['threshold breached']`), 2 for C; the printed totals read `read 7, inserted 6, dropped 1`; 3 probe rows remain; 0 `region='agent'` rows; all three incidents that were open are `resolved` with an `IncidentUpdate` and still carry their `monitor_id`; the resolved one is untouched; the second run changes nothing (row counts identical); `servers:rollback` restores 6 agent rows (the metric-less one is gone for good, by design), nulls `server_id`, and A's old token ingests again.
- `tests/feature/server-metrics.test.ts` (add): "a push writes zero `check_results` rows for any attached monitor" — the voting-bug invariant.
- `tests/feature/api-team-scoping.test.ts` (add): `/api/servers` index/show scoped; `PATCH /api/monitors/{id}` with another team's `server_id` → monitor page renders detached (the read-side guard); `POST /api/incidents` with another team's `server_id` → 403 and **no** `incident:created` (no `SendNotification` dispatch); with another team's `monitor_id` → 403; with both or neither → 422; `PATCH /api/incidents/{id}` on a team incident changing `server_id` → 422, on another team's incident → 404.
- `tests/unit/server-suggestion.test.ts`: exact match, first-label match (`web-01` ↔ `web-01.example.com`), `default`-only server never suggested, non-matching → null.
- `tests/unit/display.test.ts` (add): `serverStatusPill` never returns `pill-down`; `incidentPillClass` with `''` type returns amber for `server_hot`, `server_silent` and legacy `server_metrics`, grey when resolved.
- `tests/unit/notification-severity.test.ts` (add): `server_hot` → issue, `server_silent` → issue, `server_metrics` → issue, all with empty monitor type.
- `tests/feature/prune-server-samples.test.ts`: rows older than the cutoff go, newer stay; `SERVER_METRIC_SAMPLE_RETENTION_DAYS` is honoured.

---

## 8. Ship order

Each step is deployable alone and safe to stop after. The order of 1 → 2 → 3 is strict: the backfill must never run before the new code is live, because an old-code process still running `CheckStaleMetrics`' `monitor_id AND region='agent'` baseline query (`CheckStaleMetrics.ts:46-53`) against moved rows hits the `created_at` fallback and opens missed-push incidents fleet-wide — and because step 2 is what stops monitor tokens being minted, which phase B and 0000000285 both rely on.

1. **Schema + models + retention (additive, no behaviour change).** Migrations 0000000281–0000000284 with every index; `Server.ts`, `ServerMetricSample.ts`, `Monitor.serverId`, `Incident.serverId`; `PruneOldServerMetricSamples` + its schedule line + the `# Retention` block in `.env.example` (both variables, §4.4); `buddy generate:db-types`. Old code ignores every new column. Reversible by dropping the two new tables and columns.
2. **Deploy the new code (dual-read, no more minting).** New `ReceiveMetricsAction` with the §3.6 legacy fallback; `CheckStaleServers` scheduled alongside `CheckStaleMetrics` (the latter now `whereNull('server_id')`); `serverIncidents.ts`, `notificationSeverity` additions, the notification listeners' server branch, `AcknowledgeIncidentAction` server branch, the `POST` / `PATCH /api/incidents` overrides (§4.9), incidents index/overview merge; **the monitor-action and `monitorForm` cleanup of §6.2** (no path mints `monitors.metrics_token`; the monitor forms lose their metrics fields and gain `server_id`; the columns stay and are ignored); `CreateServerAction` + `POST /api/servers` so a monitor created in this window can still get a box; the `servers:backfill` / `servers:rollback` commands. No servers exist yet unless someone creates one, so every existing agent push still takes the legacy path. Restart every process that runs app code (web, queue worker, scheduler) so no old-code process survives into step 3.
3. **Backfill.** `buddy servers:backfill` on production. Then, after confirming the agent-row count it printed has stopped changing (about ten minutes, or immediately once every process from step 2 has been restarted), `buddy servers:backfill --final`, which sweeps rows any lingering old-code process wrote and asserts zero `region='agent'` rows remain. From here every live agent push resolves a `servers` row; uptime numbers for formerly mixed monitors correct themselves (§5); the stacked incidents are closed; the legacy fallback is unreachable (§3.6). Rollback at this point is `buddy servers:rollback`.
4. **UI.** Server pages, nav entry, monitor Server card + dialog, `new.stx` select, site page re-source, the remaining server form actions and routes, `display.ts` additions, docs and marketing copy. Attach the orphan-token monitors from §2 phase B to their box by hand here.
5. **Verify.** One full day: `SELECT COUNT(*) FROM check_results WHERE region='agent'` stays 0; `CheckWorkerHealth` logs nothing spurious; no monitor with `server_id` has had `status` written by the ingest (`updated_at` audit); at most one open incident per server per kind; incident counts flat; `SELECT COUNT(*) FROM monitors WHERE metrics_token IS NOT NULL AND server_id IS NULL` is 0 and stays 0; the prune ran.
6. **Remove the old path.** Run `buddy servers:backfill --final` once more, immediately before this step's deploy, so its assertions are the last word on the columns being dropped. Then delete `legacyReceiveMetrics.ts` and the fallback, `CheckStaleMetrics.ts` and its schedule line, `parseMetricsThresholds`, `readingsFromRows`, `reportsMetrics`/`metricsToken` from `Monitor.ts`, `coerceCheckbox` if now unused, the old tests' fixtures; migration 0000000285 (drop columns); `buddy generate:db-types`. From here `reports_metrics` does not exist anywhere in the repo. `servers:rollback` is deleted with it — after this step there is no column to roll back to.

---

## 9. Open questions

1. **Public status page and a hot box** (from the plan). Default here: nothing — a threshold breach touches no `monitors.status`, no uptime %, and no `whereIn('monitor_id', …)` incident query, so the public page reflects only what users experience; a warm CPU is not an outage. If the status page is meant to double as an ops dashboard and a hot box should show as "Degraded" publicly, that is a new join (`status_page_monitors → monitors.server_id → servers.status`) and a policy call, not a bug.
2. **Severity of "agent went quiet".** This spec routes `server_silent` as **issue**, the same as `server_hot`. That is what production does today (`CheckStaleMetrics` writes `type: 'server_metrics'`, which classifies as issue), so nobody's paging changes at ship; the only thing that said otherwise was a test fixture with a marker shape nothing writes. It is one line to flip: move `'server_silent'` from `ISSUE_CHECK_TYPES` to a `DOWN_CHECK_TYPES` set in `app/lib/notificationSeverity.ts`, and the down-only channels start paging for a stopped agent. The pages render it amber either way.
3. **Per-sample webhooks.** `DeliverCheckResultWebhooks` fires on `checkresult:created`; agent pushes stop feeding it. Any customer integration consuming a row per CPU sample goes quiet. Options: nothing (default), or `observe: ['create']` on `ServerMetricSample` + a `servermetricsample:created` listener with a new event type.
4. **Plan limits for servers.** `config/plans.ts` meters monitors and status pages only; a free team capped at 5 monitors can create unlimited servers (each a token and a sample stream). Default: unmetered for now; if you want a cap, it is one `servers` field in `PlanLimits` and one check in the two create actions mirroring `DashboardCreateMonitorAction.ts:67-72`.
5. **Metric-less legacy rows.** Phase D drops them (§0.6). If a record of "the agent pushed at this time but sent nothing usable" is ever wanted, it would need nullable percent columns and every reader of `server_metric_samples` to skip null readings; nothing today wants it, and the timestamps have already served their one purpose (the missed-push baseline).
