import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * `buddy servers:migrate` / `buddy servers:rollback` (SERVER-MODEL-SPEC.md §2
 * "Backfill", ship step 3) against a production-shaped scratch database.
 *
 * The suite's own database is never touched. The framework resolves the
 * SQLite path from its config object (config/database.ts reads
 * DB_DATABASE_PATH once, at evaluation) and caches the connection at module
 * level, so setting the env here only works when this file happens to be the
 * first to touch the database — true when it runs alone, false in CI, where
 * `bun buddy test` runs every suite in one process and an earlier file has
 * already opened the connection on the suite database. beforeAll therefore
 * re-points the framework explicitly with initializeDbConfig(), and afterAll
 * puts the original config back so
 * the suites that follow reconnect to theirs. Schema is built the way server-migrations.test.ts
 * builds it — the legacy tables inline from the migration files' text, then
 * 0000000281..0000000284 applied from disk. bun:sqlite on the same file gives
 * the assertions a second, independent connection for raw snapshots.
 *
 * The fixture mirrors what production looked like on 2026-09-02
 * (scratchpad production-findings.md): two monitors that report host
 * 'default' and are DIFFERENT machines, two monitors sharing one token, two
 * monitors with distinct tokens and real host labels and tuned thresholds,
 * four monitors whose token was issued but whose agent never pushed, one
 * monitor with a live token and reports_metrics = 0, legacy agent rows with
 * no numeric metrics, probe rows in other regions, 45 open breach incidents
 * (five on one monitor) + 5 open "agent went quiet" incidents, and unrelated
 * open incidents that must survive.
 */
const SCRATCH_DIR = process.env.SERVERS_MIGRATE_SCRATCH || join(import.meta.dir, '../temp')
const DB_PATH = join(SCRATCH_DIR, `servers-migrate-${process.pid}-${Date.now()}.sqlite`)
const JOURNAL_PATH = join(SCRATCH_DIR, `servers-migrate-${process.pid}-${Date.now()}.journal.json`)

mkdirSync(SCRATCH_DIR, { recursive: true })
// Deliberately NOT set at module load: `bun test` imports every file in the
// run before executing any, so a top-level env mutation here would re-point
// the whole process's database config at this scratch file — for every
// suite, in every order — before a single test ran. beforeAll re-points the
// framework explicitly, and afterAll hands it back.

const MIGRATIONS_DIR = join(import.meta.dir, '../../database/migrations')

const NOW = '2026-09-02T12:00:00.000Z'
const MIN = 60_000

// Legacy tables as the live migrations created them (0000000116/117/118/119
// plus the ALTERs 0000000156/192/193). Inline for the reason
// server-migrations.test.ts gives: `buddy migrate` deletes the generated
// create files from disk, so they cannot be read back in CI.
const LEGACY_SCHEMA = [
  `CREATE TABLE "monitors" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "team_id" INTEGER, "name" TEXT, "url" TEXT, "type" TEXT CHECK ("type" IN ('uptime', 'ssl', 'broken_links', 'performance', 'lighthouse', 'domain', 'dns', 'health', 'cron', 'ping', 'tcp_port', 'port_scan', 'dns_blocklist', 'ai_check')), "enabled" INTEGER default 1, "check_interval_seconds" INTEGER default 60, "config" TEXT, "status" TEXT CHECK ("status" IN ('up', 'down', 'degraded', 'paused', 'unknown')) default 'unknown', "last_checked_at" TEXT, "created_at" TEXT not null default CURRENT_TIMESTAMP, "updated_at" TEXT, "uuid" TEXT, "consecutive_failures" INTEGER default 0, "reports_metrics" INTEGER default 0, "metrics_token" TEXT)`,
  `CREATE TABLE "check_results" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "status" TEXT CHECK ("status" IN ('up', 'down', 'degraded')), "response_time_ms" INTEGER, "status_code" INTEGER, "message" TEXT, "metadata" TEXT, "region" TEXT default 'default', "checked_at" TEXT, "monitor_id" INTEGER REFERENCES "monitors"("id"), "created_at" TEXT not null default CURRENT_TIMESTAMP, "updated_at" TEXT, "uuid" TEXT)`,
  `CREATE UNIQUE INDEX "check_results_uuid_unique" ON "check_results" ("uuid")`,
  `CREATE TABLE "incidents" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "started_at" TEXT, "resolved_at" TEXT, "cause" TEXT, "status" TEXT CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved')) default 'investigating', "impacted_checks" TEXT, "monitor_id" INTEGER REFERENCES "monitors"("id"), "created_at" TEXT not null default CURRENT_TIMESTAMP, "updated_at" TEXT, "uuid" TEXT)`,
  `CREATE TABLE "incident_updates" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "user_id" INTEGER, "message" TEXT, "status" TEXT CHECK ("status" IN ('investigating', 'identified', 'monitoring', 'resolved')), "posted_at" TEXT, "incident_id" INTEGER REFERENCES "incidents"("id"), "created_at" TEXT not null default CURRENT_TIMESTAMP, "updated_at" TEXT, "uuid" TEXT)`,
  // Touched by the incident:updated listener (SendIncidentResolvedNotification)
  // the model calls in phase C fire. Empty stand-ins: nothing to notify.
  `CREATE TABLE "maintenance_windows" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "team_id" INTEGER, "starts_at" TEXT, "ends_at" TEXT, "status" TEXT, "recurrence_cron" TEXT, "duration_minutes" INTEGER)`,
  `CREATE TABLE "maintenance_window_monitors" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "maintenance_window_id" INTEGER, "monitor_id" INTEGER)`,
  `CREATE TABLE "monitor_notification_channels" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "monitor_id" INTEGER, "notification_channel_id" INTEGER, "fires_on" TEXT)`,
  `CREATE TABLE "notification_channels" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "team_id" INTEGER, "type" TEXT, "config" TEXT, "enabled" INTEGER)`,
  `CREATE TABLE "status_page_monitors" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "status_page_id" INTEGER, "monitor_id" INTEGER)`,
  `CREATE TABLE "status_page_subscribers" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "status_page_id" INTEGER, "email" TEXT)`,
  `CREATE TABLE "teams" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "uuid" TEXT, "name" TEXT)`,
]

const SERVER_MIGRATIONS = [
  '0000000281-create-servers-table.sql',
  '0000000282-create-server_metric_samples-table.sql',
  '0000000283-alter-monitors-server_id.sql',
  '0000000284-alter-incidents-server_id.sql',
]

const TABLES = ['monitors', 'check_results', 'incidents', 'incident_updates', 'servers', 'server_metric_samples']

function statements(sql: string): string[] {
  return sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean)
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const TEAM = 7
const TOKENS = {
  shared: 'tok-shared-48-64',
  redline: 'tok-49-redline',
  api: 'tok-51-easyotc-api',
  stage: 'tok-60-easyotc-stage',
  bughq: 'tok-55-bughq-flag-off',
  loghq: 'tok-56-never-installed',
  reportshq: 'tok-57-never-installed',
  analyticshq: 'tok-58-never-installed',
  usa: 'tok-62-never-installed',
}

interface MonitorSeed { id: number, name: string, url: string, type: string, config: string | null, reports_metrics: number, metrics_token: string | null }

const MONITORS: MonitorSeed[] = [
  { id: 48, name: 'UptimeStatus production server', url: 'https://uptime-status.org/', type: 'uptime', config: '{}', reports_metrics: 1, metrics_token: TOKENS.shared },
  { id: 49, name: 'Redline server (Orozco origin)', url: 'https://orozcosautoservice.com/', type: 'uptime', config: null, reports_metrics: 1, metrics_token: TOKENS.redline },
  { id: 51, name: 'easyotc-api', url: 'https://api.easyotc.example/', type: 'health', config: '{"cpuThreshold":50,"ramThreshold":50,"diskThreshold":60}', reports_metrics: 1, metrics_token: TOKENS.api },
  { id: 55, name: 'bughq', url: 'https://bughq.example/', type: 'uptime', config: '{}', reports_metrics: 0, metrics_token: TOKENS.bughq },
  { id: 56, name: 'loghq', url: 'https://loghq.example/', type: 'uptime', config: '{}', reports_metrics: 1, metrics_token: TOKENS.loghq },
  { id: 57, name: 'reportshq', url: 'https://reportshq.example/', type: 'uptime', config: '{}', reports_metrics: 1, metrics_token: TOKENS.reportshq },
  { id: 58, name: 'analyticshq', url: 'https://analyticshq.example/', type: 'uptime', config: '{}', reports_metrics: 1, metrics_token: TOKENS.analyticshq },
  { id: 60, name: 'easyotc-stage-api', url: 'https://stage.easyotc.example/', type: 'health', config: '{"cpuThreshold":50,"ramThreshold":50,"diskThreshold":70,"metricsWindowSeconds":"bogus"}', reports_metrics: 1, metrics_token: TOKENS.stage },
  { id: 62, name: 'Usa Server', url: 'https://usa.example/', type: 'uptime', config: '{}', reports_metrics: 1, metrics_token: TOKENS.usa },
  { id: 64, name: 'analyticshq worker', url: 'https://worker.analyticshq.example/', type: 'uptime', config: '{}', reports_metrics: 1, metrics_token: TOKENS.shared },
  { id: 70, name: 'no-agent api', url: 'https://third-party.example/', type: 'uptime', config: null, reports_metrics: 0, metrics_token: null },
]

interface Reading { cpu: number, ram: number, usedMb?: number, totalMb?: number, disk?: number | null, breaches?: string[] }

function ago(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * MIN).toISOString()
}

/** A row exactly as legacyReceiveMetrics wrote it. */
function legacyRow(monitorId: number, host: string, checkedAt: string, r: Reading): Record<string, unknown> {
  const breaches = r.breaches ?? []
  const hasDisk = r.disk !== undefined && r.disk !== null
  return {
    monitor_id: monitorId,
    status: breaches.length > 0 ? 'degraded' : 'up',
    response_time_ms: null,
    status_code: null,
    message: breaches.length > 0 ? `Threshold breach on ${host}: ${breaches.join('; ')}` : `Agent metrics received from ${host}`,
    metadata: JSON.stringify({ host, cpuPercent: r.cpu, ramPercent: r.ram, ramUsedMb: r.usedMb ?? 4096, ramTotalMb: r.totalMb ?? 16384, ...(hasDisk ? { diskPercent: r.disk } : {}), breaches }),
    region: 'agent',
    checked_at: checkedAt,
    created_at: checkedAt,
    updated_at: null,
    uuid: crypto.randomUUID(),
  }
}

function metriclessRow(monitorId: number, checkedAt: string, metadata: string | null): Record<string, unknown> {
  return { monitor_id: monitorId, status: 'up', response_time_ms: null, status_code: null, message: 'Agent metrics received', metadata, region: 'agent', checked_at: checkedAt, created_at: checkedAt, updated_at: null, uuid: crypto.randomUUID() }
}

function probeRow(monitorId: number, region: string, checkedAt: string, status = 'up'): Record<string, unknown> {
  return { monitor_id: monitorId, status, response_time_ms: 120, status_code: 200, message: 'OK', metadata: JSON.stringify({ region }), region, checked_at: checkedAt, created_at: checkedAt, updated_at: null, uuid: crypto.randomUUID() }
}

function breachIncident(monitorId: number, startedAt: string, host: string): Record<string, unknown> {
  return {
    started_at: startedAt,
    resolved_at: null,
    cause: `Host resource threshold breached: ${host === 'default' ? '' : `${host}: `}CPU 96% ≥ 50%`,
    status: 'investigating',
    impacted_checks: JSON.stringify([{ type: 'server_metrics', hosts: [{ host, breaches: ['CPU 96% ≥ 50%'] }] }]),
    monitor_id: monitorId,
    created_at: startedAt,
    updated_at: startedAt,
    uuid: crypto.randomUUID(),
  }
}

function quietIncident(monitorId: number, startedAt: string): Record<string, unknown> {
  return {
    started_at: startedAt,
    resolved_at: null,
    cause: 'No server metrics received in 300s',
    status: 'investigating',
    impacted_checks: JSON.stringify([{ type: 'server_metrics', reason: 'missed_push', windowSeconds: 300 }]),
    monitor_id: monitorId,
    created_at: startedAt,
    updated_at: startedAt,
    uuid: crypto.randomUUID(),
  }
}

function otherIncident(monitorId: number, startedAt: string, type: string, resolved = false): Record<string, unknown> {
  return {
    started_at: startedAt,
    resolved_at: resolved ? ago(60) : null,
    cause: `${type} problem`,
    status: resolved ? 'resolved' : 'investigating',
    impacted_checks: JSON.stringify([{ type, region: 'eu-central' }]),
    monitor_id: monitorId,
    created_at: startedAt,
    updated_at: startedAt,
    uuid: crypto.randomUUID(),
  }
}

let raw: Database

function insert(table: string, row: Record<string, unknown>): void {
  const keys = Object.keys(row)
  raw.run(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map(k => row[k]) as never[])
}

function resetAndSeed(): void {
  raw.run('PRAGMA foreign_keys = OFF')
  for (const table of TABLES)
    raw.run(`DELETE FROM "${table}"`)
  raw.run('DELETE FROM sqlite_sequence')
  if (existsSync(JOURNAL_PATH))
    rmSync(JOURNAL_PATH)

  raw.transaction(() => {
    for (const m of MONITORS) {
      insert('monitors', {
        id: m.id,
        team_id: TEAM,
        name: m.name,
        url: m.url,
        type: m.type,
        enabled: 1,
        check_interval_seconds: 60,
        config: m.config,
        status: 'up',
        last_checked_at: ago(1),
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        uuid: crypto.randomUUID(),
        consecutive_failures: 0,
        reports_metrics: m.reports_metrics,
        metrics_token: m.metrics_token,
        server_id: null,
      })
    }

    // check_results, interleaved so every id-range batch is sparse and mixed.
    const rows: Record<string, unknown>[] = []

    // 48 — the shared Hetzner box: 2 hours of samples, host '' then 'default'.
    for (let i = 120; i >= 2; i--)
      rows.push(legacyRow(48, i > 60 ? '' : 'default', ago(i), { cpu: 12 + (i % 7), ram: 41, disk: 63 }))
    // Legacy rows with no reading at all; the newest of them is the newest
    // agent row on this token, so last_sample_at must come from it.
    rows.push(metriclessRow(48, '2026-07-06T09:00:00.000Z', '{}'))
    rows.push(metriclessRow(48, '2026-07-06T09:01:00.000Z', null))
    rows.push(metriclessRow(48, '2026-07-06T09:02:00.000Z', '{"host":"","cpuPercent":"n/a"}'))
    rows.push(metriclessRow(48, ago(0.5), '{"host":"default"}'))
    // 64 — a second site on the same box, pushing with the same token.
    for (let i = 30; i >= 3; i -= 3)
      rows.push(legacyRow(64, 'default', ago(i + 0.25), { cpu: 9, ram: 40, disk: 63 }))

    // 49 — a different machine that ALSO says host 'default'.
    for (let i = 60; i >= 1; i--)
      rows.push(legacyRow(49, 'default', ago(i), { cpu: 20, ram: 55 }))

    // 51 — easyotc-api: 2400 samples, tuned thresholds, hot right now.
    for (let i = 2400; i >= 1; i--) {
      const hot = i <= 3
      rows.push(legacyRow(51, 'ip-172-31-7-9', ago(i), { cpu: hot ? 95 : 30, ram: 35, disk: 40, usedMb: 5734, totalMb: 16384, breaches: hot ? ['CPU 95% ≥ 50%'] : [] }))
    }

    // 60 — easyotc-stage-api: went quiet 20 minutes ago.
    for (let i = 300; i >= 20; i--)
      rows.push(legacyRow(60, 'ip-172-31-12-103', ago(i), { cpu: 22, ram: 48, disk: 55 }))

    // 55 — bughq: reports_metrics = 0 but the token is live and pushing.
    for (let i = 10; i >= 1; i--)
      rows.push(legacyRow(55, 'default', ago(i + 0.5), { cpu: 5, ram: 30 }))

    // Probe rows in real regions — must come out untouched.
    for (let i = 120; i >= 1; i--) {
      rows.push(probeRow(48, 'eu-central', ago(i)))
      rows.push(probeRow(49, 'eu-central', ago(i), i % 40 === 0 ? 'down' : 'up'))
      rows.push(probeRow(51, 'eu-central', ago(i)))
    }
    for (let i = 60; i >= 1; i--)
      rows.push(probeRow(48, 'us-east', ago(i * 24 * 60)))
    for (let i = 5; i >= 1; i--)
      rows.push(probeRow(48, 'default', ago(i * 24 * 60 + 5)))

    rows.sort((a, b) => String(a.checked_at).localeCompare(String(b.checked_at)))
    for (const row of rows)
      insert('check_results', row)

    // Incidents: 45 open breaches (five on 60), 5 open quiet, unrelated open ones, some resolved.
    insert('incidents', breachIncident(48, ago(500), 'default'))
    insert('incidents', breachIncident(49, ago(490), 'default'))
    for (let i = 0; i < 5; i++)
      insert('incidents', breachIncident(60, ago(480 - i * 10), 'ip-172-31-12-103'))
    for (let i = 0; i < 38; i++)
      insert('incidents', breachIncident(51, ago(400 - i * 5), 'ip-172-31-7-9'))
    for (const id of [55, 56, 57, 58, 62])
      insert('incidents', quietIncident(id, ago(13 * 24 * 60)))
    for (let i = 0; i < 4; i++)
      insert('incidents', otherIncident(49, ago(300 - i), 'performance'))
    for (let i = 0; i < 3; i++)
      insert('incidents', otherIncident(51, ago(200 - i), 'dns'))
    insert('incidents', otherIncident(48, ago(100), 'ssl'))
    insert('incidents', otherIncident(48, ago(90), 'ssl'))
    // Already resolved server_metrics incidents: history, untouched.
    for (let i = 0; i < 2; i++) {
      insert('incidents', { ...breachIncident(48, ago(3000 - i), 'default'), status: 'resolved', resolved_at: ago(2900 - i) })
      const id = Number((raw.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id)
      insert('incident_updates', { user_id: null, message: 'Host resource usage back within thresholds.', status: 'resolved', posted_at: ago(2900 - i), incident_id: id, created_at: ago(2900 - i), updated_at: null, uuid: crypto.randomUUID() })
    }
  })()
}

// ---------------------------------------------------------------------------
// Raw helpers
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function all(sql: string, ...params: unknown[]): Row[] {
  return raw.query(sql).all(...params as never[]) as Row[]
}

function one(sql: string, ...params: unknown[]): Row {
  return raw.query(sql).get(...params as never[]) as Row
}

function count(sql: string, ...params: unknown[]): number {
  return Number((raw.query(sql).get(...params as never[]) as { n: number }).n)
}

function snapshot(): Record<string, Row[]> {
  const out: Record<string, Row[]> = {}
  for (const table of TABLES)
    out[table] = all(`SELECT * FROM "${table}" ORDER BY id`)
  return out
}

/**
 * check_results with the columns a restore cannot preserve (id, uuid)
 * removed, in a stable order. Agent rows written before the ingest
 * normalised host labels carry host '' in metadata and message; a rebuilt row
 * carries the normalised 'default' (normalizeHost('') === 'default', and that
 * is what readingsFromRows read the '' rows as anyway), so the pre-migration
 * side is canonicalised the same way before comparing.
 */
function checkResultsShape(rows: Row[]): Row[] {
  return rows
    .map(({ id: _id, uuid: _uuid, ...rest }) => {
      if (rest.region !== 'agent' || typeof rest.metadata !== 'string')
        return rest
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(rest.metadata)
      }
      catch {
        return rest
      }
      if (meta.host !== '' || typeof meta.cpuPercent !== 'number')
        return rest
      return { ...rest, metadata: JSON.stringify({ ...meta, host: 'default' }), message: String(rest.message).replace(/ from $/, ' from default').replace(/ on : /, ' on default: ') }
    })
    .sort((a, b) => `${a.monitor_id}|${a.checked_at}|${a.region}`.localeCompare(`${b.monitor_id}|${b.checked_at}|${b.region}`))
}

function openIncidentIds(): number[] {
  return all('SELECT id FROM incidents WHERE resolved_at IS NULL ORDER BY id').map(r => Number(r.id))
}

function serverByToken(token: string): Row {
  return one('SELECT * FROM servers WHERE metrics_token = ?', token)
}

function monitor(id: number): Row {
  return one('SELECT * FROM monitors WHERE id = ?', id)
}

function journal(): any[] {
  return JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'))
}

const quiet = { log: () => {} }

type Migrate = typeof import('../../app/Commands/MigrateServers')
let cmd: Migrate
let originalDbConfig: { app: unknown, database: unknown } | null = null

describe('servers:migrate', () => {
  beforeAll(async () => {
    raw = new Database(DB_PATH, { create: true })
    raw.run('PRAGMA journal_mode = WAL')
    for (const statement of LEGACY_SCHEMA)
      raw.run(statement)
    for (const file of SERVER_MIGRATIONS) {
      for (const statement of statements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')))
        raw.run(statement)
    }
    // Re-point the framework's connection at the scratch file no matter which
    // suite touched the database first. ensureDatabaseConfigLoaded() runs the
    // framework's own one-time init before we override it, so that init can
    // never fire later and quietly put the suite database back.
    //
    // initializeDbConfig() only drops the cached instance, so the next use
    // opens a fresh connection on the new path. It deliberately does NOT
    // close anything: resetDatabaseConnection() closes the shared SQLite
    // handle, and the ORM's auto-CRUD routes keep their own query-builder
    // instance on that handle, so closing it here made every later route in
    // the run fail with "Cannot use a closed database" once file order put
    // this suite before them.
    process.env.SERVERS_MIGRATE_JOURNAL = JOURNAL_PATH
    const { config, awaitConfig } = await import('@stacksjs/config')
    await awaitConfig()
    const { ensureDatabaseConfigLoaded, initializeDbConfig } = await import('@stacksjs/database')
    await ensureDatabaseConfigLoaded()
    originalDbConfig = { app: config.app, database: config.database }
    initializeDbConfig({
      app: config.app,
      database: {
        ...config.database,
        connections: {
          ...config.database?.connections,
          sqlite: { ...config.database?.connections?.sqlite, database: DB_PATH },
        },
      },
    } as never)
    cmd = await import('../../app/Commands/MigrateServers')
  })

  afterAll(async () => {
    // Hand the connection back to the suite database for whatever runs next
    // (drops our cached instance; closes nothing — see beforeAll).
    const { initializeDbConfig } = await import('@stacksjs/database')
    if (originalDbConfig)
      initializeDbConfig(originalDbConfig as never)
    delete process.env.SERVERS_MIGRATE_JOURNAL
    raw?.close()
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      if (existsSync(`${DB_PATH}${suffix}`))
        rmSync(`${DB_PATH}${suffix}`)
    }
    if (existsSync(JOURNAL_PATH))
      rmSync(JOURNAL_PATH)
  })

  beforeEach(() => {
    resetAndSeed()
  })

  test('the framework connection is on the scratch file, not the suite database', async () => {
    const { db } = await import('@stacksjs/database')
    expect(Number(await db.selectFrom('monitors').count())).toBe(MONITORS.length)
    expect(Number(await db.selectFrom('check_results').where('region', '=', 'agent').count())).toBe(count(`SELECT COUNT(*) AS n FROM check_results WHERE region = 'agent'`))
  })

  test('fixture sanity: the production shape is present', () => {
    expect(count(`SELECT COUNT(*) AS n FROM check_results WHERE region = 'agent'`)).toBe(119 + 4 + 10 + 60 + 2400 + 281 + 10)
    expect(openIncidentIds()).toHaveLength(45 + 5 + 9)
    expect(count(`SELECT COUNT(DISTINCT metrics_token) AS n FROM monitors WHERE metrics_token IS NOT NULL`)).toBe(9)
  })

  describe('--dry-run', () => {
    test('prints every count and writes nothing', async () => {
      const before = snapshot()
      const lines: string[] = []
      const report = await cmd.runServersMigrate({ dryRun: true, now: NOW, log: line => lines.push(line) })

      expect(snapshot()).toEqual(before)
      expect(existsSync(JOURNAL_PATH)).toBe(false)

      expect(report.serversCreated.map(s => s.token).sort()).toEqual([TOKENS.api, TOKENS.bughq, TOKENS.redline, TOKENS.shared, TOKENS.stage].sort())
      expect(report.orphans.map(o => o.monitor_id)).toEqual([56, 57, 58, 62])
      expect(report.incidentsResolved).toHaveLength(50)
      expect(report.totals.read).toBe(2884)
      expect(report.totals.convertible).toBe(2880)
      expect(report.totals.metricless).toBe(4)
      expect(report.totals.inserted).toBe(0)
      expect(report.agentRowsRemaining).toBe(2884)

      const text = lines.join('\n')
      expect(text).toContain('[dry-run]')
      expect(text).toContain('servers created:            5')
      expect(text).toContain('orphan tokens dropped:      4')
      expect(text).toContain('incidents resolved:         50')
      expect(text).toContain('metric-less rows dropped:   4')
      expect(text).toContain('(dry-run: nothing written)')
    })
  })

  describe('B1 population', () => {
    test('one server per distinct token with agent rows, grouped by token and never by host label', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })

      expect(count('SELECT COUNT(*) AS n FROM servers')).toBe(5)
      const shared = serverByToken(TOKENS.shared)
      const redline = serverByToken(TOKENS.redline)
      expect(shared).toBeTruthy()
      expect(redline).toBeTruthy()
      // Both boxes report host 'default'; they are two servers.
      expect(shared.id).not.toBe(redline.id)
      // Two monitors, one token, one server.
      expect(monitor(48).server_id).toBe(shared.id)
      expect(monitor(64).server_id).toBe(shared.id)
      expect(monitor(49).server_id).toBe(redline.id)
      expect(monitor(51).server_id).toBe(serverByToken(TOKENS.api).id)
      expect(monitor(60).server_id).toBe(serverByToken(TOKENS.stage).id)
    })

    test('reports_metrics is never read: a flag-off monitor with a live token gets a server', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const bughq = serverByToken(TOKENS.bughq)
      expect(bughq).toBeTruthy()
      expect(monitor(55).server_id).toBe(bughq.id)
      expect(monitor(55).reports_metrics).toBe(0)
    })

    test('no token is minted: every server token is one a monitor already had', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const seeded = new Set(MONITORS.map(m => m.metrics_token).filter(Boolean))
      for (const row of all('SELECT metrics_token FROM servers'))
        expect(seeded.has(String(row.metrics_token))).toBe(true)
    })

    test('a token shared across teams aborts before anything is written', async () => {
      raw.run('UPDATE monitors SET team_id = 8 WHERE id = 64')
      const before = snapshot()
      await expect(cmd.runServersMigrate({ now: NOW, ...quiet })).rejects.toThrow(/spans teams 7, 8/)
      expect(snapshot()).toEqual(before)
    })
  })

  describe('B2 server row', () => {
    test('carries the monitor name, team, verbatim token, parsed thresholds, last_sample_at and a uuid', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })

      const shared = serverByToken(TOKENS.shared)
      expect(shared.team_id).toBe(TEAM)
      // First monitor by id wins the name.
      expect(shared.name).toBe('UptimeStatus production server')
      expect(shared.metrics_token).toBe(TOKENS.shared)
      expect(shared.cpu_threshold).toBe(90)
      expect(shared.ram_threshold).toBe(90)
      expect(shared.disk_threshold).toBe(85)
      expect(shared.metrics_window_seconds).toBe(300)
      // MAX(checked_at) over ALL agent rows on the token — the newest is a metric-less row.
      expect(shared.last_sample_at).toBe(ago(0.5))
      expect(String(shared.uuid)).toMatch(/^[0-9a-f-]{36}$/)
      expect(shared.created_at).toBe(NOW)

      const api = serverByToken(TOKENS.api)
      expect(api.name).toBe('easyotc-api')
      expect(api.cpu_threshold).toBe(50)
      expect(api.ram_threshold).toBe(50)
      expect(api.disk_threshold).toBe(60)
      expect(api.last_sample_at).toBe(ago(1))

      const stage = serverByToken(TOKENS.stage)
      expect(stage.disk_threshold).toBe(70)
      // Non-numeric window → default.
      expect(stage.metrics_window_seconds).toBe(300)
      expect(stage.last_sample_at).toBe(ago(20))

      // Defaults where the monitor had no config at all.
      const redline = serverByToken(TOKENS.redline)
      expect(redline.cpu_threshold).toBe(90)
      expect(redline.metrics_window_seconds).toBe(300)
    })
  })

  describe('B3 orphans', () => {
    test('tokens with no agent rows get no server and are nulled, and the journal keeps them', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      for (const id of [56, 57, 58, 62]) {
        expect(monitor(id).metrics_token).toBeNull()
        expect(monitor(id).server_id).toBeNull()
      }
      for (const token of [TOKENS.loghq, TOKENS.reportshq, TOKENS.analyticshq, TOKENS.usa])
        expect(serverByToken(token)).toBeNull()
      expect(count('SELECT COUNT(*) AS n FROM monitors WHERE metrics_token IS NOT NULL AND server_id IS NULL')).toBe(0)

      const [entry] = journal()
      expect(entry.orphan_tokens_dropped).toEqual([
        { monitor_id: 56, token: TOKENS.loghq },
        { monitor_id: 57, token: TOKENS.reportshq },
        { monitor_id: 58, token: TOKENS.analyticshq },
        { monitor_id: 62, token: TOKENS.usa },
      ])
    })
  })

  describe('B4 samples', () => {
    test('every agent row moves or is dropped, field by field, and nothing else in check_results changes', async () => {
      const probesBefore = all(`SELECT * FROM check_results WHERE region != 'agent' ORDER BY id`)
      const legacy = all(`SELECT * FROM check_results WHERE region = 'agent' ORDER BY id`)

      const report = await cmd.runServersMigrate({ now: NOW, ...quiet })

      expect(all(`SELECT * FROM check_results WHERE region != 'agent' ORDER BY id`)).toEqual(probesBefore)
      expect(count(`SELECT COUNT(*) AS n FROM check_results WHERE region = 'agent'`)).toBe(0)
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples')).toBe(2880)
      expect(report.totals).toEqual({ read: 2884, convertible: 2880, metricless: 4, inserted: 2880 })
      expect(report.agentRowsRemaining).toBe(0)

      // Field mapping, checked on a breaching easyotc row.
      const hot = legacy.find(r => String(r.metadata).includes('CPU 95%'))!
      const meta = JSON.parse(String(hot.metadata))
      const sample = one('SELECT * FROM server_metric_samples WHERE server_id = ? AND sampled_at = ?', serverByToken(TOKENS.api).id, hot.checked_at)
      expect(sample.host).toBe('ip-172-31-7-9')
      expect(sample.cpu_percent).toBe(meta.cpuPercent)
      expect(sample.ram_percent).toBe(meta.ramPercent)
      expect(sample.ram_used_mb).toBe(5734)
      expect(sample.ram_total_mb).toBe(16384)
      expect(sample.disk_percent).toBe(40)
      expect(sample.breaches).toBe(JSON.stringify(['CPU 95% ≥ 50%']))
      expect(sample.sampled_at).toBe(hot.checked_at)

      // No disk reported → NULL; empty host label → 'default'; missing MB → 0.
      const redline = one('SELECT * FROM server_metric_samples WHERE server_id = ? ORDER BY sampled_at DESC LIMIT 1', serverByToken(TOKENS.redline).id)
      expect(redline.disk_percent).toBeNull()
      expect(redline.host).toBe('default')
      const blank = one('SELECT * FROM server_metric_samples WHERE server_id = ? ORDER BY sampled_at ASC LIMIT 1', serverByToken(TOKENS.shared).id)
      expect(blank.host).toBe('default')

      // Per-token counts.
      const shared = serverByToken(TOKENS.shared)
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', shared.id)).toBe(119 + 10)
      expect(report.samples[TOKENS.shared]).toEqual({ read: 133, convertible: 129, metricless: 4, inserted: 129 })
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', serverByToken(TOKENS.api).id)).toBe(2400)
    })

    test('a batch whose insert falls short aborts before deleting its source rows', async () => {
      // Silently swallow the insert of one easyotc row: inserted != convertible.
      raw.run(`CREATE TRIGGER poison BEFORE INSERT ON server_metric_samples WHEN NEW.sampled_at = '${ago(1500)}' BEGIN SELECT RAISE(IGNORE); END`)
      try {
        const agentBefore = count(`SELECT COUNT(*) AS n FROM check_results WHERE region = 'agent'`)
        await expect(cmd.runServersMigrate({ now: NOW, ...quiet })).rejects.toThrow(/aborting before deleting anything/)

        // The poisoned batch's rows are all still there, and none of its samples landed.
        const api = serverByToken(TOKENS.api)
        expect(api).toBeTruthy()
        const poisoned = one(`SELECT id FROM check_results WHERE monitor_id = 51 AND checked_at = ?`, ago(1500))
        expect(poisoned).toBeTruthy()
        const from = Math.floor((Number(poisoned.id) - Number(one(`SELECT MIN(id) AS id FROM check_results WHERE monitor_id IN (51) AND region = 'agent'`).id)) / cmd.BATCH)
        const lo = Number(one(`SELECT MIN(id) AS id FROM check_results WHERE monitor_id IN (51) AND region = 'agent'`).id) + from * cmd.BATCH
        const batchRows = count(`SELECT COUNT(*) AS n FROM check_results WHERE monitor_id = 51 AND region = 'agent' AND id >= ? AND id < ?`, lo, lo + cmd.BATCH)
        expect(batchRows).toBeGreaterThan(0)
        expect(count(`SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ? AND sampled_at = ?`, api.id, ago(1500))).toBe(0)
        // Every source row either moved (sample exists) or is still in place — none lost.
        const moved = count('SELECT COUNT(*) AS n FROM server_metric_samples')
        const remaining = count(`SELECT COUNT(*) AS n FROM check_results WHERE region = 'agent'`)
        expect(moved + remaining + 4 /* metric-less rows on 48 that were legitimately dropped, if that batch ran */).toBeGreaterThanOrEqual(agentBefore)
        expect(remaining).toBeGreaterThan(0)
      }
      finally {
        raw.run('DROP TRIGGER poison')
      }
    })
  })

  describe('B5 status', () => {
    test('healthy / hot / quiet from the moved samples inside the window', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      expect(serverByToken(TOKENS.shared).status).toBe('healthy')
      expect(serverByToken(TOKENS.redline).status).toBe('healthy')
      expect(serverByToken(TOKENS.bughq).status).toBe('healthy')
      expect(serverByToken(TOKENS.api).status).toBe('hot')
      expect(serverByToken(TOKENS.stage).status).toBe('quiet')
      expect(count(`SELECT COUNT(*) AS n FROM servers WHERE status = 'unknown'`)).toBe(0)
    })

    test('only a metric-less row inside the window is healthy, not quiet', async () => {
      raw.run(`DELETE FROM check_results WHERE monitor_id IN (48, 64) AND region = 'agent' AND checked_at >= ?`, [ago(5)] as never)
      raw.run(`UPDATE check_results SET checked_at = ? WHERE monitor_id = 48 AND region = 'agent' AND metadata = '{}'`, [ago(2)] as never)
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      expect(serverByToken(TOKENS.shared).status).toBe('healthy')
      expect(serverByToken(TOKENS.shared).last_sample_at).toBe(ago(2))
    })
  })

  describe('B6 incidents', () => {
    test('every open server_metrics incident is resolved with an update; nothing else is touched', async () => {
      const before = Object.fromEntries(all('SELECT * FROM incidents').map(r => [Number(r.id), r]))
      const updatesBefore = all('SELECT * FROM incident_updates ORDER BY id')
      const targets = all(`SELECT id FROM incidents WHERE resolved_at IS NULL AND impacted_checks LIKE '%server_metrics%' ORDER BY id`).map(r => Number(r.id))
      expect(targets).toHaveLength(50)

      const report = await cmd.runServersMigrate({ now: NOW, ...quiet })
      expect(report.incidentsResolved).toEqual(targets)

      for (const id of targets) {
        const row = one('SELECT * FROM incidents WHERE id = ?', id)
        expect(row.status).toBe('resolved')
        expect(row.resolved_at).toBe(NOW)
        expect(row.monitor_id).toBe(before[id].monitor_id)
        expect(row.server_id).toBeNull()
        expect(row.impacted_checks).toBe(before[id].impacted_checks)
        const update = one('SELECT * FROM incident_updates WHERE incident_id = ? ORDER BY id DESC LIMIT 1', id)
        expect(update.status).toBe('resolved')
        expect(update.message).toBe(cmd.MIGRATION_RESOLVED_MESSAGE)
        expect(update.posted_at).toBe(NOW)
      }

      // The 9 unrelated open incidents stay open, untouched.
      const stillOpen = openIncidentIds()
      expect(stillOpen).toHaveLength(9)
      for (const id of stillOpen)
        expect(one('SELECT * FROM incidents WHERE id = ?', id)).toEqual(before[id])

      // Already-resolved history is untouched, and its updates too.
      for (const row of all(`SELECT * FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at != ?`, NOW))
        expect(row).toEqual(before[Number(row.id)])
      expect(all('SELECT * FROM incident_updates ORDER BY id').slice(0, updatesBefore.length)).toEqual(updatesBefore)
      expect(count('SELECT COUNT(*) AS n FROM incident_updates')).toBe(updatesBefore.length + 50)
    })

    test('the orphan monitors\' perpetual quiet incidents are resolved even though they get no server', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      for (const id of [56, 57, 58, 62]) {
        expect(count(`SELECT COUNT(*) AS n FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL`, id)).toBe(0)
        expect(monitor(id).server_id).toBeNull()
      }
    })
  })

  describe('B7 idempotent and re-runnable', () => {
    test('running twice produces identical state', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const first = snapshot()
      const report = await cmd.runServersMigrate({ now: NOW, ...quiet })
      expect(snapshot()).toEqual(first)
      expect(report.serversCreated).toHaveLength(0)
      expect(report.serversExisting).toHaveLength(5)
      expect(report.orphans).toHaveLength(0)
      expect(report.incidentsResolved).toHaveLength(0)
      expect(report.totals.read).toBe(0)
      expect(journal()).toHaveLength(2)
    })

    test('--final sweeps rows an old-code process wrote between runs', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const api = serverByToken(TOKENS.api)
      const samplesBefore = count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', api.id)
      for (let i = 0; i < 3; i++)
        insert('check_results', legacyRow(51, 'ip-172-31-7-9', ago(-i - 1), { cpu: 31, ram: 36, disk: 41 }))
      insert('check_results', legacyRow(64, 'default', ago(-1), { cpu: 8, ram: 40 }))

      const report = await cmd.runServersMigrate({ now: NOW, final: true, ...quiet })
      expect(report.serversCreated).toHaveLength(0)
      expect(report.totals).toEqual({ read: 4, convertible: 4, metricless: 0, inserted: 4 })
      expect(report.agentRowsRemaining).toBe(0)
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', api.id)).toBe(samplesBefore + 3)
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', serverByToken(TOKENS.shared).id)).toBe(129 + 1)
      expect(count('SELECT COUNT(*) AS n FROM servers')).toBe(5)
      expect(journal()).toHaveLength(2)
      expect(journal()[1].final).toBe(true)
    })

    test('--final fails when an agent row cannot be swept because its monitor has no token', async () => {
      insert('check_results', legacyRow(70, 'default', ago(3), { cpu: 1, ram: 2 }))
      const lines: string[] = []
      await expect(cmd.runServersMigrate({ now: NOW, final: true, log: line => lines.push(line) })).rejects.toThrow(/1 region='agent' row\(s\) remain.*monitor 70, which has no token/)
      expect(lines.join('\n')).toContain('agent rows on token-less monitors (not swept): monitor 70: 1')
      // Everything else still migrated; the leftover row is exactly the one reported.
      expect(count('SELECT COUNT(*) AS n FROM servers')).toBe(5)
      expect(all(`SELECT monitor_id FROM check_results WHERE region = 'agent'`)).toEqual([{ monitor_id: 70 }])
    })

    test('a server that already exists is skipped for creation but its monitors are attached and swept', async () => {
      const api = serverByToken(TOKENS.api)
      expect(api).toBeNull()
      insert('servers', { team_id: TEAM, name: 'pre-made', metrics_token: TOKENS.api, status: 'healthy', last_sample_at: ago(1), uuid: crypto.randomUUID(), created_at: ago(2), updated_at: ago(2) })
      const pre = serverByToken(TOKENS.api)

      const report = await cmd.runServersMigrate({ now: NOW, ...quiet })
      expect(report.serversCreated).toHaveLength(4)
      expect(report.serversExisting).toEqual([{ id: Number(pre.id), token: TOKENS.api, monitor_ids: [51] }])
      expect(monitor(51).server_id).toBe(pre.id)
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', pre.id)).toBe(2400)
      // Not created here: name, thresholds and status are the pre-existing server's own.
      expect(serverByToken(TOKENS.api).name).toBe('pre-made')
      expect(serverByToken(TOKENS.api).status).toBe('healthy')
      expect(journal()[0].servers_created.map((s: any) => s.token)).not.toContain(TOKENS.api)
    })
  })

  describe('B8 journal', () => {
    test('one entry per run with servers, orphans, per-server sample counts, incidents and timestamps', async () => {
      const report = await cmd.runServersMigrate({ now: NOW, ...quiet })
      const entries = journal()
      expect(entries).toHaveLength(1)
      const [entry] = entries
      expect(entry.version).toBe(1)
      expect(entry.started_at).toBe(NOW)
      expect(Date.parse(entry.finished_at)).toBeGreaterThan(0)
      expect(entry.final).toBe(false)
      expect(entry.rolled_back_at).toBeNull()

      expect(entry.servers_created).toHaveLength(5)
      const shared = entry.servers_created.find((s: any) => s.token === TOKENS.shared)
      expect(shared).toMatchObject({ id: serverByToken(TOKENS.shared).id, token: TOKENS.shared, monitor_ids: [48, 64], name: 'UptimeStatus production server' })

      expect(entry.samples_moved).toHaveLength(5)
      const sharedSweep = entry.samples_moved.find((s: any) => s.server_id === shared.id)
      expect(sharedSweep).toMatchObject({ read: 133, convertible: 129, metricless: 4, inserted: 129, monitor_ids: [48, 64] })
      expect(sharedSweep.metricless_rows).toHaveLength(4)
      // Sample runs cover every moved sample exactly once and map them to the monitor they came from.
      const covered = sharedSweep.sample_runs.reduce((n: number, [, from, to]: number[]) => n + (to - from + 1), 0)
      expect(covered).toBe(129)
      expect(new Set(sharedSweep.sample_runs.map((r: number[]) => r[0]))).toEqual(new Set([48, 64]))

      expect(entry.orphan_tokens_dropped).toHaveLength(4)
      expect(entry.incidents_resolved).toEqual(report.incidentsResolved)
      expect(entry.incidents_resolved).toHaveLength(50)
      expect(entry.outcome).toBe('complete')
      expect(entry.error).toBeNull()
    })

    test('an aborted run is journaled as it goes, so nothing it wrote is unrecorded', async () => {
      // Poison one easyotc row in the third batch: phase D trips after the
      // servers, orphans, incidents and the earlier sweeps have all landed.
      raw.run(`CREATE TRIGGER poison BEFORE INSERT ON server_metric_samples WHEN NEW.host = 'ip-172-31-7-9' AND NEW.sampled_at = '${ago(100)}' BEGIN SELECT RAISE(IGNORE); END`)
      try {
        await expect(cmd.runServersMigrate({ now: NOW, ...quiet })).rejects.toThrow(/aborting before deleting anything/)
      }
      finally {
        raw.run('DROP TRIGGER poison')
      }

      const entries = journal()
      expect(entries).toHaveLength(1)
      const [entry] = entries
      expect(entry.outcome).toBe('aborted')
      expect(entry.error).toMatch(/aborting before deleting anything/)
      expect(entry.rolled_back_at).toBeNull()

      // Every effect that landed is on record: the servers and attachments…
      expect(entry.servers_created.map((s: any) => s.id).sort()).toEqual(all('SELECT id FROM servers ORDER BY id').map(r => Number(r.id)))
      expect(count('SELECT COUNT(*) AS n FROM monitors WHERE server_id IS NOT NULL')).toBe(6)
      // …the dropped orphan tokens, which now exist nowhere but here…
      expect(entry.orphan_tokens_dropped).toEqual([56, 57, 58, 62].map(id => ({ monitor_id: id, token: MONITORS.find(m => m.id === id)!.metrics_token })))
      expect(count('SELECT COUNT(*) AS n FROM monitors WHERE id IN (56, 57, 58, 62) AND metrics_token IS NULL')).toBe(4)
      // …the resolved incidents…
      expect(entry.incidents_resolved).toHaveLength(50)
      expect(count(`SELECT COUNT(*) AS n FROM incidents WHERE status = 'resolved' AND resolved_at = ?`, NOW)).toBe(50)
      // …and exactly the sample batches that committed, no more and no fewer.
      const journaled = entry.samples_moved.reduce((n: number, s: any) => n + s.inserted, 0)
      expect(journaled).toBe(count('SELECT COUNT(*) AS n FROM server_metric_samples'))
      expect(journaled).toBeGreaterThan(0)
      for (const sweep of entry.samples_moved) {
        const covered = sweep.sample_runs.reduce((n: number, [, from, to]: number[]) => n + (to - from + 1), 0)
        expect(covered).toBe(sweep.inserted)
        expect(count('SELECT COUNT(*) AS n FROM server_metric_samples WHERE server_id = ?', sweep.server_id)).toBe(sweep.inserted)
      }
      const api = entry.samples_moved.find((s: any) => s.token === TOKENS.api)
      expect(api.read).toBeLessThan(2400)
    })
  })

  describe('B9 report', () => {
    test('prints the final counts', async () => {
      const lines: string[] = []
      await cmd.runServersMigrate({ now: NOW, log: line => lines.push(line) })
      const text = lines.join('\n')
      expect(text).toContain('servers created:            5')
      expect(text).toContain('monitors attached:          6')
      expect(text).toContain('orphan tokens dropped:      4 (monitors 56, 57, 58, 62)')
      expect(text).toContain('agent rows read:            2884')
      expect(text).toContain('samples inserted:           2880')
      expect(text).toContain('metric-less rows dropped:   4')
      expect(text).toContain('incidents resolved:         50')
      expect(text).toContain('agent rows remaining:       0')
      expect(text).toContain('tokens without a server:    0 (must be 0)')
    })
  })

  describe('servers:rollback', () => {
    test('refuses without --yes', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      await expect(cmd.runServersRollback({ now: NOW })).rejects.toThrow(/--yes/)
    })

    test('restores the pre-migration state on every affected table', async () => {
      const before = snapshot()
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const migrated = snapshot()
      expect(migrated).not.toEqual(before)

      const report = await cmd.runServersRollback({ yes: true, now: NOW, ...quiet })
      const after = snapshot()

      expect(report.serversDeleted).toHaveLength(5)
      expect(report.samplesRestored).toBe(2880)
      expect(report.metriclessRestored).toBe(4)
      expect(report.tokensRestored).toBe(4)
      expect(report.incidentsReopened).toHaveLength(50)
      expect(report.entriesRemaining).toBe(0)

      expect(after.servers).toEqual([])
      expect(after.server_metric_samples).toEqual([])
      // monitors: byte-for-byte (server_id back to NULL, tokens back).
      expect(after.monitors).toEqual(before.monitors)
      // check_results: every row back — samples rebuilt in the old ingest's
      // shape on their own monitor, metric-less rows verbatim — modulo the
      // new ids and the fresh uuids a rebuilt row gets.
      expect(after.check_results).toHaveLength(before.check_results.length)
      expect(checkResultsShape(after.check_results)).toEqual(checkResultsShape(before.check_results))
      // Metric-less rows come back with their original uuid too.
      const metricless = before.check_results.filter(r => r.region === 'agent' && r.message === 'Agent metrics received')
      expect(metricless).toHaveLength(4)
      for (const row of metricless)
        expect(one('SELECT uuid FROM check_results WHERE uuid = ?', row.uuid)).toBeTruthy()
      // Probe rows: identical, ids included.
      expect(after.check_results.filter(r => r.region !== 'agent')).toEqual(before.check_results.filter(r => r.region !== 'agent'))
      // incidents: status and resolved_at restored, everything else untouched.
      expect(after.incidents.map(({ updated_at: _u, ...rest }) => rest)).toEqual(before.incidents.map(({ updated_at: _u, ...rest }) => rest))
      // incident_updates: the originals intact, plus one "resolved" and one
      // "reopened" note per touched incident — the audit trail is kept on purpose.
      expect(after.incident_updates.slice(0, before.incident_updates.length)).toEqual(before.incident_updates)
      expect(after.incident_updates.length).toBe(before.incident_updates.length + 100)
      const reopened = after.incident_updates.slice(-50)
      for (const update of reopened) {
        expect(update.status).toBe('investigating')
        expect(update.message).toBe(cmd.ROLLBACK_REOPENED_MESSAGE)
        expect(update.posted_at).toBe(NOW)
      }
      expect(journal()[0].rolled_back_at).toBe(NOW)
    })

    test('reverses a --final sweep and then the creating run, one entry at a time', async () => {
      const before = snapshot()
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const extra = legacyRow(51, 'ip-172-31-7-9', ago(-2), { cpu: 33, ram: 36, disk: 41 })
      insert('check_results', extra)
      await cmd.runServersMigrate({ now: NOW, final: true, ...quiet })
      expect(count(`SELECT COUNT(*) AS n FROM check_results WHERE region = 'agent'`)).toBe(0)

      const first = await cmd.runServersRollback({ yes: true, now: NOW, ...quiet })
      expect(first.serversDeleted).toEqual([])
      expect(first.samplesRestored).toBe(1)
      expect(first.entriesRemaining).toBe(1)
      expect(count('SELECT COUNT(*) AS n FROM servers')).toBe(5)
      expect(one(`SELECT metadata FROM check_results WHERE region = 'agent'`).metadata).toBe(extra.metadata)

      const second = await cmd.runServersRollback({ yes: true, now: NOW, ...quiet })
      expect(second.serversDeleted).toHaveLength(5)
      expect(second.entriesRemaining).toBe(0)
      const after = snapshot()
      expect(after.monitors).toEqual(before.monitors)
      expect(after.servers).toEqual([])
      expect(after.server_metric_samples).toEqual([])
      const restored = checkResultsShape(after.check_results)
      const expected = checkResultsShape([...before.check_results, extra as Row])
      expect(restored).toEqual(expected)
      await expect(cmd.runServersRollback({ yes: true, now: NOW, ...quiet })).rejects.toThrow(/nothing to reverse/)
    })

    test('reverses an aborted run, and a re-run after the abort, back to the pre-migration state', async () => {
      const before = snapshot()
      raw.run(`CREATE TRIGGER poison BEFORE INSERT ON server_metric_samples WHEN NEW.host = 'ip-172-31-7-9' AND NEW.sampled_at = '${ago(100)}' BEGIN SELECT RAISE(IGNORE); END`)
      try {
        await expect(cmd.runServersMigrate({ now: NOW, ...quiet })).rejects.toThrow(/aborting before deleting anything/)
      }
      finally {
        raw.run('DROP TRIGGER poison')
      }

      // Straight back from the aborted run alone.
      const lines: string[] = []
      const report = await cmd.runServersRollback({ yes: true, now: NOW, log: line => lines.push(line) })
      expect(lines.join('\n')).toContain('that run ABORTED')
      expect(report.serversDeleted).toHaveLength(5)
      expect(report.tokensRestored).toBe(4)
      expect(report.incidentsReopened).toHaveLength(50)
      expect(report.entriesRemaining).toBe(0)
      const after = snapshot()
      expect(after.monitors).toEqual(before.monitors)
      expect(after.servers).toEqual([])
      expect(after.server_metric_samples).toEqual([])
      expect(checkResultsShape(after.check_results)).toEqual(checkResultsShape(before.check_results))
      expect(openIncidentIds()).toEqual(before.incidents.filter(i => i.resolved_at === null).map(i => Number(i.id)))
      expect(journal()[0].rolled_back_at).toBe(NOW)

      // Abort again, then let a successful re-run finish the job: two
      // entries, reversed newest first, land on the same pre-migration state.
      resetAndSeed()
      const reseeded = snapshot()
      raw.run(`CREATE TRIGGER poison BEFORE INSERT ON server_metric_samples WHEN NEW.host = 'ip-172-31-7-9' AND NEW.sampled_at = '${ago(100)}' BEGIN SELECT RAISE(IGNORE); END`)
      try {
        await expect(cmd.runServersMigrate({ now: NOW, ...quiet })).rejects.toThrow(/aborting before deleting anything/)
      }
      finally {
        raw.run('DROP TRIGGER poison')
      }
      const rerun = await cmd.runServersMigrate({ now: NOW, final: true, ...quiet })
      expect(rerun.serversCreated).toHaveLength(0)
      expect(rerun.serversExisting).toHaveLength(5)
      expect(rerun.agentRowsRemaining).toBe(0)
      expect(count('SELECT COUNT(*) AS n FROM server_metric_samples')).toBe(2880)
      expect(journal().map((e: any) => e.outcome)).toEqual(['aborted', 'complete'])

      const first = await cmd.runServersRollback({ yes: true, now: NOW, ...quiet })
      expect(first.serversDeleted).toEqual([])
      expect(first.entriesRemaining).toBe(1)
      const second = await cmd.runServersRollback({ yes: true, now: NOW, ...quiet })
      expect(second.serversDeleted).toHaveLength(5)
      expect(second.tokensRestored).toBe(4)
      expect(second.incidentsReopened).toHaveLength(50)
      expect(second.entriesRemaining).toBe(0)
      const restored = snapshot()
      expect(restored.monitors).toEqual(reseeded.monitors)
      expect(restored.servers).toEqual([])
      expect(restored.server_metric_samples).toEqual([])
      expect(checkResultsShape(restored.check_results)).toEqual(checkResultsShape(reseeded.check_results))
      expect(openIncidentIds()).toEqual(reseeded.incidents.filter(i => i.resolved_at === null).map(i => Number(i.id)))
    })

    test('refuses when a created server has received samples after the migration, and changes nothing', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const api = serverByToken(TOKENS.api)
      const [entry] = journal()
      const later = new Date(Date.parse(entry.finished_at) + 5 * MIN).toISOString()
      insert('server_metric_samples', { host: 'ip-172-31-7-9', cpu_percent: 12, ram_percent: 30, ram_used_mb: 1, ram_total_mb: 2, disk_percent: null, breaches: '[]', sampled_at: later, server_id: api.id, created_at: later })
      const migrated = snapshot()

      await expect(cmd.runServersRollback({ yes: true, now: NOW, ...quiet })).rejects.toThrow(new RegExp(`refusing — server ${api.id}: 1 sample\\(s\\) after ${entry.finished_at}, newest ${later}.*DELETE FROM server_metric_samples`))
      expect(snapshot()).toEqual(migrated)
      expect(journal()[0].rolled_back_at).toBeNull()
    })

    test('a server incident opened after the migration is resolved by the rollback', async () => {
      await cmd.runServersMigrate({ now: NOW, ...quiet })
      const api = serverByToken(TOKENS.api)
      insert('incidents', { started_at: NOW, resolved_at: null, cause: 'ip-172-31-7-9: CPU 95% ≥ 50%', status: 'investigating', impacted_checks: JSON.stringify([{ type: 'server_hot', hosts: [] }]), monitor_id: null, server_id: api.id, created_at: NOW, updated_at: NOW, uuid: crypto.randomUUID() })
      const report = await cmd.runServersRollback({ yes: true, now: NOW, ...quiet })
      expect(report.serverIncidentsResolved).toBe(1)
      const row = one('SELECT * FROM incidents WHERE server_id = ?', api.id)
      expect(row.status).toBe('resolved')
      expect(row.resolved_at).toBe(NOW)
    })
  })
})
