import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/**
 * The four hand-written Server migrations (0000000281..0000000284), applied
 * to a fresh throwaway SQLite file and inspected through PRAGMAs.
 *
 * Hand-written because the model-driven generator only ever emits
 * CREATE TABLE IF NOT EXISTS per model and never a column alter, so
 * monitors.server_id and incidents.server_id can only come from an ALTER
 * somebody typed. That is exactly the kind of SQL a typo survives in until
 * production: nothing else in the suite parses these files, and the
 * suite's own database has usually had them applied already (or never
 * will, on a machine that only runs unit tests). A dedicated file is the
 * one place the schema these files produce is asserted, index by index.
 *
 * Deliberately not the framework migration runner: that needs the whole
 * app booted against the configured database, and this must never touch
 * it. bun:sqlite on a file under tests/temp (gitignored) is the same engine
 * production runs on.
 */
const MIGRATIONS_DIR = join(import.meta.dir, '../../database/migrations')
const TEMP_DIR = join(import.meta.dir, '../temp')
const DB_PATH = join(TEMP_DIR, `server-migrations-${process.pid}-${Date.now()}.sqlite`)

const SERVER_MIGRATIONS = [
  '0000000281-create-servers-table.sql',
  '0000000282-create-server_metric_samples-table.sql',
  '0000000283-alter-monitors-server_id.sql',
  '0000000284-alter-incidents-server_id.sql',
]

/**
 * The two tables 0000000283/0000000284 extend, created inline rather than by
 * replaying the repo's own create-table migrations.
 *
 * Those framework-generated create files are transient: `buddy migrate`
 * records them and then DELETES them from database/migrations. CI runs
 * migrate before the test suite, so by the time this file runs
 * 0000000220-create-monitors-table.sql no longer exists on disk and reading
 * it throws ENOENT. Only the ALTERs' target needs to exist here, and only the
 * columns they touch matter, so a minimal stand-in is both sufficient and
 * immune to that deletion.
 */
const PREREQUISITE_TABLES = [
  'CREATE TABLE IF NOT EXISTS "monitors" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT, "url" TEXT)',
  'CREATE TABLE IF NOT EXISTS "incidents" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "monitor_id" INTEGER, "cause" TEXT)',
]

/**
 * bun:sqlite prepares one statement at a time, so a multi-statement file is
 * split here. Comment lines are dropped first; none of these files carry a
 * semicolon inside a string literal, and the assertion below keeps it so.
 */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
}

function apply(db: Database, file: string): void {
  const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  for (const statement of statements(sql))
    db.run(statement)
}

interface ColumnInfo { cid: number, name: string, type: string, notnull: number, dflt_value: string | null, pk: number }
interface IndexInfo { name: string, unique: number, origin: string }

function columns(db: Database, table: string): ColumnInfo[] {
  return db.query(`PRAGMA table_info("${table}")`).all() as ColumnInfo[]
}

function column(db: Database, table: string, name: string): ColumnInfo | undefined {
  return columns(db, table).find(c => c.name === name)
}

function indexes(db: Database, table: string): IndexInfo[] {
  return db.query(`PRAGMA index_list("${table}")`).all() as IndexInfo[]
}

function indexColumns(db: Database, index: string): string[] {
  return (db.query(`PRAGMA index_info("${index}")`).all() as Array<{ seqno: number, name: string }>)
    .sort((a, b) => a.seqno - b.seqno)
    .map(c => c.name)
}

describe('Server migrations 0000000281..0000000284', () => {
  let db: Database

  beforeAll(() => {
    mkdirSync(TEMP_DIR, { recursive: true })
    db = new Database(DB_PATH, { create: true })
    for (const statement of PREREQUISITE_TABLES)
      db.run(statement)
    for (const file of SERVER_MIGRATIONS)
      apply(db, file)
  })

  afterAll(() => {
    db?.close()
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = `${DB_PATH}${suffix}`
      if (existsSync(path))
        rmSync(path)
    }
  })

  test('the four files exist and nothing else shares their ordinals', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter(f => /^000000028[1-4]-/.test(f)).sort()
    expect(files).toEqual(SERVER_MIGRATIONS)
  })

  test('no statement hides a semicolon inside a string literal', () => {
    // Guards the splitter above: every statement must start with a DDL verb.
    for (const file of SERVER_MIGRATIONS) {
      for (const statement of statements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')))
        expect(statement).toMatch(/^(CREATE|ALTER) /)
    }
  })

  describe('servers', () => {
    test('has exactly the columns the model declares, in order', () => {
      expect(columns(db, 'servers').map(c => c.name)).toEqual([
        'id',
        'team_id',
        'name',
        'metrics_token',
        'cpu_threshold',
        'ram_threshold',
        'disk_threshold',
        'metrics_window_seconds',
        'status',
        'last_sample_at',
        'created_at',
        'updated_at',
        'uuid',
      ])
    })

    test('defaults match the model (90/90/85, 300s, status unknown)', () => {
      expect(column(db, 'servers', 'cpu_threshold')!.dflt_value).toBe('90')
      expect(column(db, 'servers', 'ram_threshold')!.dflt_value).toBe('90')
      expect(column(db, 'servers', 'disk_threshold')!.dflt_value).toBe('85')
      expect(column(db, 'servers', 'metrics_window_seconds')!.dflt_value).toBe('300')
      expect(column(db, 'servers', 'status')!.dflt_value).toBe(`'unknown'`)
      expect(column(db, 'servers', 'last_sample_at')!.dflt_value).toBeNull()
      expect(column(db, 'servers', 'created_at')!.notnull).toBe(1)
    })

    test('a row inserted with only the required fields gets those defaults', () => {
      db.run(`INSERT INTO "servers" ("team_id", "name", "metrics_token") VALUES (1, 'box', 'tok-defaults')`)
      const row = db.query(`SELECT * FROM "servers" WHERE "metrics_token" = 'tok-defaults'`).get() as Record<string, unknown>
      expect(row.cpu_threshold).toBe(90)
      expect(row.ram_threshold).toBe(90)
      expect(row.disk_threshold).toBe(85)
      expect(row.metrics_window_seconds).toBe(300)
      expect(row.status).toBe('unknown')
      expect(row.last_sample_at).toBeNull()
      expect(row.created_at).toBeTruthy()
    })

    test('metrics_token and uuid are unique, team_id is indexed', () => {
      const byName = Object.fromEntries(indexes(db, 'servers').map(i => [i.name, i]))
      expect(byName.servers_metrics_token_unique?.unique).toBe(1)
      expect(indexColumns(db, 'servers_metrics_token_unique')).toEqual(['metrics_token'])
      expect(byName.servers_uuid_unique?.unique).toBe(1)
      expect(indexColumns(db, 'servers_uuid_unique')).toEqual(['uuid'])
      expect(byName.servers_team_id_index?.unique).toBe(0)
      expect(indexColumns(db, 'servers_team_id_index')).toEqual(['team_id'])
    })

    test('a duplicate token is a hard error, not a silent second row', () => {
      db.run(`INSERT INTO "servers" ("team_id", "name", "metrics_token") VALUES (1, 'a', 'tok-dup')`)
      expect(() => db.run(`INSERT INTO "servers" ("team_id", "name", "metrics_token") VALUES (1, 'b', 'tok-dup')`))
        .toThrow(/UNIQUE constraint failed: servers.metrics_token/)
    })
  })

  describe('server_metric_samples', () => {
    test('has exactly the columns the model declares, in order', () => {
      expect(columns(db, 'server_metric_samples').map(c => c.name)).toEqual([
        'id',
        'host',
        'cpu_percent',
        'ram_percent',
        'ram_used_mb',
        'ram_total_mb',
        'disk_percent',
        'breaches',
        'sampled_at',
        'server_id',
        'created_at',
        'updated_at',
      ])
    })

    test('the four readings are REAL and required; disk is optional', () => {
      for (const name of ['cpu_percent', 'ram_percent', 'ram_used_mb', 'ram_total_mb']) {
        expect(column(db, 'server_metric_samples', name)!.type).toBe('REAL')
        expect(column(db, 'server_metric_samples', name)!.notnull).toBe(1)
      }
      expect(column(db, 'server_metric_samples', 'disk_percent')!.type).toBe('REAL')
      expect(column(db, 'server_metric_samples', 'disk_percent')!.notnull).toBe(0)
      expect(column(db, 'server_metric_samples', 'server_id')!.notnull).toBe(1)
      expect(column(db, 'server_metric_samples', 'sampled_at')!.notnull).toBe(1)
      expect(column(db, 'server_metric_samples', 'host')!.dflt_value).toBe(`'default'`)
      expect(column(db, 'server_metric_samples', 'breaches')!.dflt_value).toBe(`'[]'`)
    })

    test('a fractional reading survives the round trip', () => {
      db.run(`INSERT INTO "server_metric_samples" ("cpu_percent", "ram_percent", "ram_used_mb", "ram_total_mb", "sampled_at", "server_id")
        VALUES (37.2, 51.9, 8123.5, 16384, '2026-09-02T00:00:00.000Z', 1)`)
      const row = db.query(`SELECT * FROM "server_metric_samples" WHERE "server_id" = 1`).get() as Record<string, unknown>
      expect(row.cpu_percent).toBe(37.2)
      expect(row.ram_used_mb).toBe(8123.5)
      expect(row.host).toBe('default')
      expect(row.breaches).toBe('[]')
      expect(row.disk_percent).toBeNull()
    })

    test('carries the three indexes the ingest, chart and prune reads use', () => {
      const names = indexes(db, 'server_metric_samples').map(i => i.name)
      expect(names).toContain('server_metric_samples_server_id_host_sampled_at_index')
      expect(names).toContain('server_metric_samples_server_id_sampled_at_index')
      expect(names).toContain('server_metric_samples_sampled_at_index')
      expect(indexColumns(db, 'server_metric_samples_server_id_host_sampled_at_index')).toEqual(['server_id', 'host', 'sampled_at'])
      expect(indexColumns(db, 'server_metric_samples_server_id_sampled_at_index')).toEqual(['server_id', 'sampled_at'])
      expect(indexColumns(db, 'server_metric_samples_sampled_at_index')).toEqual(['sampled_at'])
      for (const index of indexes(db, 'server_metric_samples'))
        expect(index.unique).toBe(0)
    })
  })

  describe('monitors.server_id and incidents.server_id', () => {
    test('both columns are added nullable INTEGER and indexed', () => {
      for (const table of ['monitors', 'incidents']) {
        const col = column(db, table, 'server_id')
        expect(col).toBeTruthy()
        expect(col!.type).toBe('INTEGER')
        expect(col!.notnull).toBe(0)
        expect(col!.dflt_value).toBeNull()
        expect(indexColumns(db, `${table}_server_id_index`)).toEqual(['server_id'])
      }
    })

    // Asserted as an invariant (everything that was there, plus server_id
    // appended) rather than against a hard-coded column list, because the
    // prerequisite tables here are minimal stand-ins — see PREREQUISITE_TABLES.
    // It is also the property that actually matters: ADD COLUMN must not
    // reorder or drop anything, which is what makes these migrations safe to
    // run against a live SQLite database.
    test('existing columns are untouched by the ALTERs, with server_id appended', () => {
      const fresh = new Database(':memory:')
      for (const statement of PREREQUISITE_TABLES)
        fresh.run(statement)

      for (const table of ['monitors', 'incidents']) {
        const before = columns(fresh, table).map(c => c.name)
        const after = columns(db, table).map(c => c.name)
        expect(after.slice(0, before.length)).toEqual(before)
        expect(after.at(-1)).toBe('server_id')
        expect(after).toHaveLength(before.length + 1)
      }

      fresh.close()
    })
  })

  test('the CREATE migrations are idempotent', () => {
    // Re-applying a create file on a database that already has it must be
    // a no-op, exactly what IF NOT EXISTS is for. (The ALTERs are not, by
    // SQLite's nature; the migrations ledger is what keeps them from running twice.)
    expect(() => {
      apply(db, '0000000281-create-servers-table.sql')
      apply(db, '0000000282-create-server_metric_samples-table.sql')
    }).not.toThrow()
    expect(columns(db, 'servers').length).toBe(13)
    expect(columns(db, 'server_metric_samples').length).toBe(12)
  })
})
