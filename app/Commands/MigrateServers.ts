import type { CLI } from '@stacksjs/types'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { db } from '@stacksjs/database'
import { transaction as ormTransaction } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import { parseMetricsThresholds } from '../Actions/Agents/metricsThresholds'
import { aggregateHostStatus, normalizeHost, numberOrNull, readingsFromSamples, serverStatusFromFleet } from '../lib/agentHosts'

/**
 * `buddy servers:migrate [--dry-run] [--final]` — the Server backfill
 * (SERVER-MODEL-SPEC.md §2 "Backfill", ship step 3), and its inverse,
 * `buddy servers:rollback --yes`.
 *
 * Not SQL: thresholds live in monitors.config JSON and samples in
 * check_results.metadata JSON, so the same TypeScript the ingest used
 * (parseMetricsThresholds, normalizeHost, numberOrNull, readingsFromSamples)
 * reinterprets nothing.
 *
 * Population is by TOKEN, never by host label: on production two monitors
 * both report host 'default' and are different machines, while several
 * monitors can share one token and are the same box. `reports_metrics` is
 * never read — a monitor with the flag off and a live token is a live agent.
 * No token is ever minted here.
 *
 * Phases, in order:
 *   A  one Server per distinct metrics_token that has at least one
 *      region='agent' check_results row; monitors.server_id attached and
 *      last_sample_at set in the same transaction as the insert, before any
 *      sample row is touched.
 *   B  tokens with no agent rows are orphans: no server, metrics_token nulled
 *      (the token is journaled so rollback can restore it).
 *   C  every open incident carrying a type:'server_metrics' marker — the
 *      breach shape and the reason:'missed_push' shape alike, on every
 *      monitor whether or not it gets a server — is resolved with an
 *      IncidentUpdate. Raw query-builder writes on purpose, NOT model calls:
 *      Incident is observed and incident:updated fans out to
 *      SendIncidentResolvedNotification, so resolving 55 incidents through
 *      the model would page every attached channel 55 times during a
 *      migration. The timeline note is the record; nobody needs waking.
 *   D  agent rows move into server_metric_samples in id-range batches of
 *      1000, one transaction per batch, and every batch asserts
 *      inserted == convertible and convertible + metric-less == read BEFORE
 *      deleting its source rows. Metric-less legacy rows (no numeric
 *      cpuPercent/ramPercent) are dropped — but journaled in full, so a
 *      rollback puts them back.
 *   E  report and assert. --final additionally asserts no agent row is left.
 *
 * Re-runnable: a token whose server exists is skipped for creation but its
 * remaining agent rows are still swept — which is what --final is for after
 * the first run. Every run appends one entry to the journal
 * (storage/framework/servers-migrate.json); servers:rollback reverses the
 * newest entry that has not been rolled back yet.
 *
 * The journal is written AS THE RUN GOES, not at the end: the entry is
 * appended (outcome 'running') just before the first write, and re-flushed
 * after every server insert, orphan drop, incident resolution and committed
 * sample batch. A phase D assertion, any other exception, or a killed process
 * therefore leaves an entry that records exactly what landed (outcome
 * 'aborted', or still 'running' if the process died), and
 * servers:rollback --yes reverses it like any other. The only unrecorded
 * window is a death between a batch's commit and the flush that follows it;
 * samples left on a created server that way are still swept back by the
 * rollback (see runServersRollback), so nothing is lost either way.
 */

/**
 * Rows per sweep batch. Overridable for a run: on a busy production database
 * every batch is one write transaction competing with the app's own writers
 * for SQLite's single lock, and a smaller batch holds it for less time.
 */
export const BATCH = Number(process.env.SERVERS_MIGRATE_BATCH) > 0 ? Number(process.env.SERVERS_MIGRATE_BATCH) : 1000

const LOCK_PATTERN = /database is locked|SQLITE_BUSY|\bbusy\b|deadlock|lock wait timeout/i

/** True for the errors SQLite (and the other dialects) raise when a writer could not get the lock. */
export function isLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return LOCK_PATTERN.test(message)
}

let retryLog: (message: string) => void = () => {}

/**
 * Run a write, retrying with backoff while the database is locked.
 *
 * The framework opens SQLite with busy_timeout = 5000, and the live run still
 * died on "database is locked": the app's ingest and check writers hold the
 * lock often enough that a five-second wait is not always enough. Every
 * caller here is either a whole transaction (rolled back on failure, so
 * re-running it from the top is safe: it re-reads before it writes) or a
 * single idempotent statement. Anything that is not a lock error is rethrown
 * at once. Worst case is about two minutes of waiting per call.
 */
export async function withLockRetry<T>(
  fn: () => Promise<T>,
  label: string,
  options: { attempts?: number, baseDelayMs?: number, maxDelayMs?: number, sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = options.attempts ?? 40
  const base = options.baseDelayMs ?? 250
  const max = options.maxDelayMs ?? 3000
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    }
    catch (err) {
      if (!isLockError(err) || attempt >= attempts)
        throw err
      const delay = Math.min(max, base * 2 ** Math.min(attempt - 1, 4))
      retryLog(`  ${label}: database is locked, retry ${attempt}/${attempts} in ${delay}ms`)
      await sleep(delay)
    }
  }
}

/** The ORM transaction, retried while the database is locked (see withLockRetry). */
const transaction: typeof ormTransaction = fn => withLockRetry(() => ormTransaction(fn), 'transaction') as ReturnType<typeof ormTransaction>

export const MIGRATION_RESOLVED_MESSAGE = 'Resolved by the server migration. Host metrics now belong to a Server, which raises at most one "box is hot" and one "agent went quiet" incident per box; see the server page for its current state.'
export const ROLLBACK_REOPENED_MESSAGE = 'Reopened by the server migration rollback (servers:rollback). Host metrics are back on the monitor.'
export const ROLLBACK_SERVER_RESOLVED_MESSAGE = 'Rolled back to per-monitor metrics.'

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export interface JournalServerCreated {
  id: number
  token: string
  monitor_ids: number[]
  name: string
  team_id: number
  status: string
  last_sample_at: string | null
}

/** A contiguous run of server_metric_samples ids that came from one monitor. */
export type SampleRun = [monitorId: number, fromSampleId: number, toSampleId: number]

export interface JournalMetriclessRow {
  monitor_id: number
  status: string | null
  response_time_ms: number | null
  status_code: number | null
  message: string | null
  metadata: string | null
  region: string
  checked_at: string | null
  uuid: string | null
  created_at: string | null
  updated_at: string | null
}

export interface JournalSweep {
  server_id: number
  token: string
  monitor_ids: number[]
  read: number
  convertible: number
  metricless: number
  inserted: number
  sample_runs: SampleRun[]
  metricless_rows: JournalMetriclessRow[]
}

/**
 * 'running' while the run is writing (a journal that still says so after the
 * process is gone means it died mid-run), 'complete' once every phase
 * finished, 'aborted' when an exception stopped it. Entries written before
 * this field existed are complete.
 */
export type JournalOutcome = 'running' | 'complete' | 'aborted'

export interface JournalEntry {
  version: 1
  started_at: string
  /** The last time this entry was flushed; the end of the run once it is complete. */
  finished_at: string
  final: boolean
  outcome?: JournalOutcome
  error?: string | null
  servers_created: JournalServerCreated[]
  samples_moved: JournalSweep[]
  orphan_tokens_dropped: { monitor_id: number, token: string }[]
  incidents_resolved: number[]
  rolled_back_at: string | null
}

export function journalPath(): string {
  return process.env.SERVERS_MIGRATE_JOURNAL || resolve(process.cwd(), 'storage/framework/servers-migrate.json')
}

export function readJournal(): JournalEntry[] {
  const path = journalPath()
  if (!existsSync(path))
    return []
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  return Array.isArray(parsed) ? parsed as JournalEntry[] : []
}

function writeJournal(entries: JournalEntry[]): void {
  const path = journalPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`)
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface MonitorRow {
  id: number
  team_id: number | null
  name: string | null
  config: string | null
  metrics_token: string | null
  server_id: number | null
}

interface AgentRow {
  id: number
  monitor_id: number
  status: string | null
  response_time_ms: number | null
  status_code: number | null
  message: string | null
  metadata: string | null
  region: string
  checked_at: string | null
  uuid: string | null
  created_at: string | null
  updated_at: string | null
}

const AGENT_ROW_COLUMNS = ['id', 'monitor_id', 'status', 'response_time_ms', 'status_code', 'message', 'metadata', 'region', 'checked_at', 'uuid', 'created_at', 'updated_at'] as const

interface SampleInsert {
  server_id: number
  host: string
  cpu_percent: number
  ram_percent: number
  ram_used_mb: number
  ram_total_mb: number
  disk_percent: number | null
  breaches: string
  sampled_at: string
  created_at: string
}

interface SampleRow {
  id: number
  server_id: number
  host: string
  cpu_percent: number
  ram_percent: number
  ram_used_mb: number
  ram_total_mb: number
  disk_percent: number | null
  breaches: string
  sampled_at: string
}

interface TokenGroup {
  token: string
  monitors: MonitorRow[]
  monitorIds: number[]
  agentRows: number
}

function safeJson(text: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((b): b is string => typeof b === 'string') : []
}

/**
 * A legacy agent row as the sample it becomes, or null when the row carries
 * no reading (a metric-less legacy row: the table's percent columns are NOT
 * NULL and there is nothing to store).
 */
export function sampleFromAgentRow(row: Pick<AgentRow, 'metadata' | 'checked_at'>, serverId: number): SampleInsert | null {
  const meta = safeJson(row.metadata)
  const cpu = numberOrNull(meta.cpuPercent)
  const ram = numberOrNull(meta.ramPercent)
  if (cpu === null || ram === null || !row.checked_at)
    return null

  return {
    server_id: serverId,
    host: normalizeHost(meta.host),
    cpu_percent: cpu,
    ram_percent: ram,
    ram_used_mb: numberOrNull(meta.ramUsedMb) ?? 0,
    ram_total_mb: numberOrNull(meta.ramTotalMb) ?? 0,
    disk_percent: numberOrNull(meta.diskPercent),
    breaches: JSON.stringify(stringArray(meta.breaches)),
    sampled_at: row.checked_at,
    created_at: row.checked_at,
  }
}

/**
 * The check_results row the pre-Server ingest (legacyReceiveMetrics) wrote
 * for this sample — same metadata keys, same status rule, same message —
 * so a rollback hands the old code exactly the rows it used to produce.
 */
export function agentRowFromSample(sample: SampleRow, monitorId: number): Omit<AgentRow, 'id'> {
  const breaches = stringArray((() => {
    try {
      return JSON.parse(sample.breaches ?? '[]')
    }
    catch {
      return []
    }
  })())
  const host = sample.host
  const metadata: Record<string, unknown> = {
    host,
    cpuPercent: sample.cpu_percent,
    ramPercent: sample.ram_percent,
    ramUsedMb: sample.ram_used_mb,
    ramTotalMb: sample.ram_total_mb,
    ...(sample.disk_percent === null || sample.disk_percent === undefined ? {} : { diskPercent: sample.disk_percent }),
    breaches,
  }

  return {
    monitor_id: monitorId,
    status: breaches.length > 0 ? 'degraded' : 'up',
    response_time_ms: null,
    status_code: null,
    message: breaches.length > 0 ? `Threshold breach on ${host}: ${breaches.join('; ')}` : `Agent metrics received from ${host}`,
    metadata: JSON.stringify(metadata),
    region: 'agent',
    checked_at: sample.sampled_at,
    uuid: crypto.randomUUID(),
    created_at: sample.sampled_at,
    updated_at: null,
  }
}

/** True when an incidents.impacted_checks JSON carries a server_metrics entry (either shape). */
export function hasServerMetricsMarker(impactedChecks: string | null | undefined): boolean {
  try {
    const parsed = JSON.parse(impactedChecks || '[]') as unknown
    return Array.isArray(parsed) && parsed.some(entry => entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'server_metrics')
  }
  catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Discovery (shared by the dry run and the real run)
// ---------------------------------------------------------------------------

async function agentRowCount(monitorId: number): Promise<number> {
  return Number(await db.selectFrom('check_results').where('monitor_id', '=', monitorId).where('region', '=', 'agent').count())
}

async function tokenGroups(): Promise<TokenGroup[]> {
  const monitors = await db.selectFrom('monitors')
    .where('metrics_token', 'is not', null)
    .select(['id', 'team_id', 'name', 'config', 'metrics_token', 'server_id'])
    .orderBy('id', 'asc')
    .execute() as unknown as MonitorRow[]

  const byToken = new Map<string, TokenGroup>()
  for (const monitor of monitors) {
    const token = String(monitor.metrics_token)
    let group = byToken.get(token)
    if (!group) {
      group = { token, monitors: [], monitorIds: [], agentRows: 0 }
      byToken.set(token, group)
    }
    group.monitors.push(monitor)
    group.monitorIds.push(Number(monitor.id))
    group.agentRows += await agentRowCount(Number(monitor.id))
  }

  return [...byToken.values()]
}

/** Open incidents that carry a server_metrics marker, on any monitor. */
/**
 * Resolve one incident and leave a timeline note, through the query builder
 * rather than the Incident model. The model is observed: incident:updated
 * fans out to SendIncidentResolvedNotification, and a migration that closes
 * dozens of incidents must not page every attached channel once per row.
 * The note in incident_updates is the durable record of what happened.
 */
async function resolveIncidentQuietly(id: number, message: string, at: string): Promise<void> {
  await withLockRetry(() => db.updateTable('incidents').set({ status: 'resolved', resolved_at: at, updated_at: at } as never).where('id', '=', id).execute(), `resolve incident ${id}`)
  await postIncidentNote(id, message, 'resolved', at)
}

async function postIncidentNote(incidentId: number, message: string, status: 'resolved' | 'investigating', at: string): Promise<void> {
  await withLockRetry(() => db.insertInto('incident_updates').values({
    incident_id: incidentId,
    message,
    status,
    posted_at: at,
    created_at: at,
    updated_at: at,
    uuid: crypto.randomUUID(),
  } as never).execute(), `note on incident ${incidentId}`)
}

async function openServerMetricsIncidentIds(): Promise<number[]> {
  const rows = await db.selectFrom('incidents')
    .where('resolved_at', 'is', null)
    .select(['id', 'impacted_checks'])
    .orderBy('id', 'asc')
    .execute() as unknown as { id: number, impacted_checks: string | null }[]
  return rows.filter(row => hasServerMetricsMarker(row.impacted_checks)).map(row => Number(row.id))
}

/**
 * The status a server backfills with, from the rows that become its samples:
 * the fleet verdict over the readings inside the window; 'healthy' when the
 * only in-window rows are metric-less (the agent was alive, it just carried
 * no reading); 'quiet' when nothing at all is inside the window. Never
 * 'unknown' — every server here has a sample.
 */
function backfillStatus(rowsInWindow: AgentRow[], nowMs: number, windowSeconds: number): 'healthy' | 'hot' | 'quiet' {
  if (rowsInWindow.length === 0)
    return 'quiet'
  const samples: SampleInsert[] = []
  for (const row of rowsInWindow) {
    const sample = sampleFromAgentRow(row, 0)
    if (sample)
      samples.push(sample)
  }
  if (samples.length === 0)
    return 'healthy'
  return serverStatusFromFleet(aggregateHostStatus(readingsFromSamples(samples), nowMs, windowSeconds))
}

// ---------------------------------------------------------------------------
// Forward: servers:migrate
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  dryRun?: boolean
  final?: boolean
  now?: string
  log?: (line: string) => void
}

export interface SweepTotals { read: number, convertible: number, metricless: number, inserted: number }

export interface MigrateReport {
  dryRun: boolean
  final: boolean
  serversCreated: JournalServerCreated[]
  serversExisting: { id: number, token: string, monitor_ids: number[] }[]
  monitorsAttached: number[]
  orphans: { monitor_id: number, name: string | null, token: string }[]
  /** Keyed by token: a dry run has no server ids yet. */
  samples: Record<string, SweepTotals>
  totals: SweepTotals
  incidentsResolved: number[]
  agentRowsRemaining: number
  agentRowsWithoutToken: { monitor_id: number, rows: number }[]
  unattachedTokens: number
}

function totalsOf(samples: Record<string, SweepTotals>): SweepTotals {
  const totals: SweepTotals = { read: 0, convertible: 0, metricless: 0, inserted: 0 }
  for (const t of Object.values(samples)) {
    totals.read += t.read
    totals.convertible += t.convertible
    totals.metricless += t.metricless
    totals.inserted += t.inserted
  }
  return totals
}

async function agentRowsOutsideTokens(): Promise<{ monitor_id: number, rows: number }[]> {
  const tokened = await db.selectFrom('monitors').where('metrics_token', 'is not', null).select(['id']).execute() as unknown as { id: number }[]
  const tokenedIds = new Set(tokened.map(r => Number(r.id)))
  const rows = await db.selectFrom('check_results').where('region', '=', 'agent').select(['monitor_id']).execute() as unknown as { monitor_id: number }[]
  const counts = new Map<number, number>()
  for (const row of rows) {
    const id = Number(row.monitor_id)
    if (!tokenedIds.has(id))
      counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()].map(([monitor_id, n]) => ({ monitor_id, rows: n })).sort((a, b) => a.monitor_id - b.monitor_id)
}

/** Every agent row for these monitors, in id order, one id-range batch at a time. */
async function forEachAgentBatch(monitorIds: number[], fn: (from: number, to: number) => Promise<void>): Promise<void> {
  const base = () => db.selectFrom('check_results').where('monitor_id', 'in', monitorIds).where('region', '=', 'agent')
  const lo = await base().min('id')
  const hi = await base().max('id')
  if (lo === null || lo === undefined || hi === null || hi === undefined)
    return
  for (let from = Number(lo); from <= Number(hi); from += BATCH)
    await fn(from, from + BATCH)
}

async function classifyOnly(monitorIds: number[]): Promise<SweepTotals> {
  const totals: SweepTotals = { read: 0, convertible: 0, metricless: 0, inserted: 0 }
  await forEachAgentBatch(monitorIds, async (from, to) => {
    const rows = await db.selectFrom('check_results')
      .where('monitor_id', 'in', monitorIds).where('region', '=', 'agent')
      .where('id', '>=', from).where('id', '<', to)
      .select(['metadata', 'checked_at'])
      .execute() as unknown as Pick<AgentRow, 'metadata' | 'checked_at'>[]
    for (const row of rows) {
      totals.read++
      if (sampleFromAgentRow(row, 0))
        totals.convertible++
      else totals.metricless++
    }
  })
  return totals
}

/**
 * Phase D for one server. One transaction per batch; the row-count
 * assertion runs before the batch's source rows are deleted, so a failure
 * rolls the batch back, throws, and leaves check_results as it was.
 *
 * `sweep` is the journal record for this server and is updated in place after
 * every committed batch, then `flush`ed, so an abort or a death part-way
 * through leaves the batches that did land on record for the rollback.
 */
async function sweepSamples(sweep: JournalSweep, flush: () => void): Promise<SweepTotals> {
  const { server_id: serverId, monitor_ids: monitorIds, sample_runs: runs, metricless_rows: metriclessRows } = sweep

  await forEachAgentBatch(monitorIds, async (from, to) => {
    await transaction(async (tx) => {
      const rows = await tx.selectFrom('check_results')
        .where('monitor_id', 'in', monitorIds).where('region', '=', 'agent')
        .where('id', '>=', from).where('id', '<', to)
        .select([...AGENT_ROW_COLUMNS])
        .orderBy('id', 'asc')
        .execute() as unknown as AgentRow[]
      if (rows.length === 0)
        return

      const convertible: { sample: SampleInsert, monitorId: number }[] = []
      const metricless: AgentRow[] = []
      for (const row of rows) {
        const sample = sampleFromAgentRow(row, serverId)
        if (sample)
          convertible.push({ sample, monitorId: Number(row.monitor_id) })
        else metricless.push(row)
      }

      const samples = () => tx.selectFrom('server_metric_samples').where('server_id', '=', serverId)
      const before = Number(await samples().count())
      const maxBefore = Number((await samples().max('id')) ?? 0)
      if (convertible.length > 0)
        await tx.insertInto('server_metric_samples').values(convertible.map(c => c.sample) as never).execute()
      const after = Number(await samples().count())
      const newIds = (await samples().where('id', '>', maxBefore).select(['id']).orderBy('id', 'asc').execute() as unknown as { id: number }[]).map(r => Number(r.id))

      // Both assertions BEFORE any source row is deleted.
      const inserted = after - before
      if (inserted !== convertible.length || newIds.length !== convertible.length || convertible.length + metricless.length !== rows.length)
        throw new Error(`servers:migrate: batch ${from}-${to} on server ${serverId} read ${rows.length}, inserted ${inserted} (${newIds.length} new ids), convertible ${convertible.length}, metric-less ${metricless.length} — aborting before deleting anything`)

      await tx.deleteFrom('check_results').where('id', 'in', rows.map(r => Number(r.id))).execute()

      for (let i = 0; i < newIds.length; i++) {
        const monitorId = convertible[i].monitorId
        const last = runs[runs.length - 1]
        if (last && last[0] === monitorId && last[2] === newIds[i] - 1)
          last[2] = newIds[i]
        else runs.push([monitorId, newIds[i], newIds[i]])
      }
      for (const row of metricless) {
        metriclessRows.push({
          monitor_id: Number(row.monitor_id),
          status: row.status,
          response_time_ms: row.response_time_ms,
          status_code: row.status_code,
          message: row.message,
          metadata: row.metadata,
          region: row.region,
          checked_at: row.checked_at,
          uuid: row.uuid,
          created_at: row.created_at,
          updated_at: row.updated_at,
        })
      }
      sweep.read += rows.length
      sweep.convertible += convertible.length
      sweep.metricless += metricless.length
      sweep.inserted += inserted
    })
    // The batch is committed: put it on record before the next one starts.
    flush()
  })

  return { read: sweep.read, convertible: sweep.convertible, metricless: sweep.metricless, inserted: sweep.inserted }
}

export async function runServersMigrate(options: MigrateOptions = {}): Promise<MigrateReport> {
  retryLog = options.log ?? (message => console.log(message))
  const dryRun = options.dryRun === true
  const final = options.final === true
  const now = options.now ?? new Date().toISOString()
  const nowMs = Date.parse(now)
  const log = options.log ?? ((line: string) => console.log(line))

  const report: MigrateReport = {
    dryRun,
    final,
    serversCreated: [],
    serversExisting: [],
    monitorsAttached: [],
    orphans: [],
    samples: {},
    totals: { read: 0, convertible: 0, metricless: 0, inserted: 0 },
    incidentsResolved: [],
    agentRowsRemaining: 0,
    agentRowsWithoutToken: [],
    unattachedTokens: 0,
  }
  const entry: JournalEntry = {
    version: 1,
    started_at: now,
    finished_at: now,
    final,
    outcome: 'running',
    error: null,
    servers_created: [],
    samples_moved: [],
    orphan_tokens_dropped: [],
    incidents_resolved: [],
    rolled_back_at: null,
  }
  // The journal file's entries with ours appended (null on a dry run, which
  // writes nothing). flush() rewrites the file with the entry as it stands;
  // it is called after every write so an aborted run stays reversible.
  const journal: JournalEntry[] | null = dryRun ? null : [...readJournal(), entry]
  const flush = (): void => {
    if (!journal)
      return
    entry.finished_at = new Date().toISOString()
    writeJournal(journal)
  }

  log(`servers:migrate${dryRun ? ' [dry-run]' : ''}${final ? ' [final]' : ''} at ${now}`)

  const groups = await tokenGroups()
  // A token whose server already exists is live whatever check_results says:
  // its rows were moved by an earlier run. Only a token with no server AND no
  // agent row has never pushed.
  const existingServers = new Map<string, number>()
  for (const row of await db.selectFrom('servers').where('metrics_token', 'is not', null).select(['id', 'metrics_token']).execute() as unknown as { id: number, metrics_token: string }[])
    existingServers.set(String(row.metrics_token), Number(row.id))
  const withSamples = groups.filter(g => g.agentRows > 0 || existingServers.has(g.token))
  const orphans = groups.filter(g => g.agentRows === 0 && !existingServers.has(g.token))
  log(`  ${groups.length} distinct token(s) on ${groups.reduce((n, g) => n + g.monitors.length, 0)} monitor(s): ${withSamples.length} live (agent rows or an existing server), ${orphans.length} never pushed`)

  // A token shared across teams is a data error to fix by hand, not to guess at.
  for (const group of withSamples) {
    const teams = new Set(group.monitors.map(m => Number(m.team_id)))
    if (teams.size > 1)
      throw new Error(`servers:migrate: token on monitors ${group.monitorIds.join(', ')} spans teams ${[...teams].join(', ')} — fix by hand before migrating`)
  }

  const runPhases = async (): Promise<void> => {
    // Phase A — servers and attachment.
    for (const group of withSamples) {
      const first = group.monitors[0]
      const thresholds = parseMetricsThresholds(first.config)
      const windowStart = new Date(nowMs - thresholds.windowSeconds * 1000).toISOString()

      const existingId = existingServers.get(group.token)
      const existing = existingId === undefined ? undefined : { id: existingId }
      const unattached = group.monitors.filter(m => m.server_id === null || m.server_id === undefined).map(m => Number(m.id))

      if (existing) {
        report.serversExisting.push({ id: Number(existing.id), token: group.token, monitor_ids: group.monitorIds })
        log(`  server ${existing.id} already holds token of monitor(s) ${group.monitorIds.join(', ')} — creation skipped${unattached.length > 0 ? `, attaching ${unattached.join(', ')}` : ''}`)
        if (!dryRun && unattached.length > 0) {
          await db.updateTable('monitors').set({ server_id: Number(existing.id) } as never)
            .where('metrics_token', '=', group.token).where('server_id', 'is', null).execute()
        }
        report.monitorsAttached.push(...unattached)
        continue
      }

      const agentBase = () => db.selectFrom('check_results').where('monitor_id', 'in', group.monitorIds).where('region', '=', 'agent')
      const lastSampleAt = (await agentBase().max('checked_at')) as string | null
      const inWindow = await agentBase().where('checked_at', '>=', windowStart).select([...AGENT_ROW_COLUMNS]).execute() as unknown as AgentRow[]
      const status = backfillStatus(inWindow, nowMs, thresholds.windowSeconds)

      const created: JournalServerCreated = {
        id: 0,
        token: group.token,
        monitor_ids: group.monitorIds,
        name: String(first.name ?? ''),
        team_id: Number(first.team_id),
        status,
        last_sample_at: lastSampleAt,
      }

      if (dryRun) {
        log(`  [dry-run] would create server "${created.name}" (team ${created.team_id}, monitors ${group.monitorIds.join(', ')}, cpu/ram/disk ${thresholds.cpu}/${thresholds.ram}/${thresholds.disk}, window ${thresholds.windowSeconds}s, status ${status}, last sample ${lastSampleAt}) and attach ${unattached.join(', ') || 'nothing'}`)
      }
      else {
        const id = await transaction(async (tx) => {
          const uuid = crypto.randomUUID()
          await tx.insertInto('servers').values({
            team_id: created.team_id,
            name: created.name,
            metrics_token: group.token,
            cpu_threshold: thresholds.cpu,
            ram_threshold: thresholds.ram,
            disk_threshold: thresholds.disk,
            metrics_window_seconds: thresholds.windowSeconds,
            status,
            last_sample_at: lastSampleAt,
            uuid,
            created_at: now,
            updated_at: now,
          } as never).execute()
          const row = await tx.selectFrom('servers').where('uuid', '=', uuid).select(['id']).executeTakeFirst() as { id: number } | undefined
          if (!row)
            throw new Error(`servers:migrate: server insert for token of monitors ${group.monitorIds.join(', ')} did not land`)
          await tx.updateTable('monitors').set({ server_id: Number(row.id) } as never)
            .where('metrics_token', '=', group.token).where('server_id', 'is', null).execute()
          return Number(row.id)
        })
        created.id = id
        entry.servers_created.push(created)
        flush()
        log(`  created server ${id} "${created.name}" (team ${created.team_id}, monitors ${group.monitorIds.join(', ')}, status ${status}, last sample ${lastSampleAt})`)
      }
      report.serversCreated.push(created)
      report.monitorsAttached.push(...unattached)
    }

    // Phase B — orphan tokens.
    for (const group of orphans) {
      for (const monitor of group.monitors)
        report.orphans.push({ monitor_id: Number(monitor.id), name: monitor.name, token: group.token })
      log(`  ${dryRun ? '[dry-run] would drop' : 'dropped'} orphan token on monitor(s) ${group.monitors.map(m => `${m.id} "${m.name}"`).join(', ')} — no agent row ever, no server`)
      if (!dryRun)
        await withLockRetry(() => db.updateTable('monitors').set({ metrics_token: null } as never).where('id', 'in', group.monitorIds).execute(), `drop token on ${group.monitorIds.join(', ')}`)
      // Journaled after the update, so the record never claims a drop that did not land.
      for (const monitor of group.monitors)
        entry.orphan_tokens_dropped.push({ monitor_id: Number(monitor.id), token: group.token })
      flush()
    }

    // Phase C — resolve open server_metrics incidents (both shapes, every monitor).
    const incidentIds = await openServerMetricsIncidentIds()
    log(`  ${dryRun ? '[dry-run] would resolve' : 'resolving'} ${incidentIds.length} open server_metrics incident(s)${incidentIds.length > 0 ? `: ${incidentIds.join(', ')}` : ''}`)
    if (!dryRun) {
      for (const id of incidentIds) {
        await resolveIncidentQuietly(id, MIGRATION_RESOLVED_MESSAGE, now)
        entry.incidents_resolved.push(id)
        flush()
      }
    }
    report.incidentsResolved = incidentIds

    // Phase D — move samples (created and pre-existing servers alike).
    const targets = [
      ...report.serversCreated.map(s => ({ id: s.id, token: s.token, monitorIds: s.monitor_ids })),
      ...report.serversExisting.map(s => ({ id: s.id, token: s.token, monitorIds: s.monitor_ids })),
    ]
    for (const target of targets) {
      if (dryRun) {
        const totals = await classifyOnly(target.monitorIds)
        report.samples[target.token] = totals
        log(`  [dry-run] server ${target.id || `(new, monitors ${target.monitorIds.join(', ')})`}: would read ${totals.read}, insert ${totals.convertible}, drop ${totals.metricless} metric-less`)
        continue
      }
      // The sweep record joins the journal on its first committed batch and is
      // updated in place after every one after that; a server with nothing to
      // sweep leaves no record.
      const sweep: JournalSweep = {
        server_id: target.id,
        token: target.token,
        monitor_ids: target.monitorIds,
        read: 0,
        convertible: 0,
        metricless: 0,
        inserted: 0,
        sample_runs: [],
        metricless_rows: [],
      }
      const totals = await sweepSamples(sweep, () => {
        if (sweep.read > 0 && !entry.samples_moved.includes(sweep))
          entry.samples_moved.push(sweep)
        flush()
      })
      report.samples[target.token] = totals
      log(`  server ${target.id}: read ${totals.read}, inserted ${totals.inserted}, dropped ${totals.metricless} metric-less`)
    }
    report.totals = totalsOf(report.samples)
  }

  // Nothing has been written yet. From here on every write is journaled as
  // soon as it lands, and an exception marks the entry aborted before it
  // propagates, so servers:rollback can reverse a run that did not finish.
  flush()
  try {
    await runPhases()
  }
  catch (error) {
    entry.outcome = 'aborted'
    entry.error = error instanceof Error ? error.message : String(error)
    flush()
    throw error
  }
  entry.outcome = 'complete'
  flush()

  // Phase E — verify and report.
  report.agentRowsRemaining = Number(await db.selectFrom('check_results').where('region', '=', 'agent').count())
  report.agentRowsWithoutToken = await agentRowsOutsideTokens()
  report.unattachedTokens = Number(await db.selectFrom('monitors').where('metrics_token', 'is not', null).where('server_id', 'is', null).count())

  printMigrateReport(report, log)

  if (!dryRun && report.unattachedTokens > 0)
    throw new Error(`servers:migrate: ${report.unattachedTokens} monitor(s) still carry a metrics_token with no server`)
  if (final && !dryRun && report.agentRowsRemaining > 0)
    throw new Error(`servers:migrate --final: ${report.agentRowsRemaining} region='agent' row(s) remain in check_results${report.agentRowsWithoutToken.length > 0 ? ` (${report.agentRowsWithoutToken.map(r => `${r.rows} on monitor ${r.monitor_id}, which has no token`).join('; ')})` : ''}`)

  return report
}

export function printMigrateReport(report: MigrateReport, log: (line: string) => void = line => console.log(line)): void {
  const dry = report.dryRun ? ' (dry-run: nothing written)' : ''
  log('')
  log(`servers:migrate report${dry}`)
  log(`  servers created:            ${report.serversCreated.length}${report.serversCreated.length > 0 ? ` (${report.serversCreated.map(s => `${s.id || 'new'} "${s.name}" ← monitors ${s.monitor_ids.join(',')}`).join('; ')})` : ''}`)
  log(`  servers already existing:   ${report.serversExisting.length}${report.serversExisting.length > 0 ? ` (${report.serversExisting.map(s => s.id).join(', ')})` : ''}`)
  log(`  monitors attached:          ${report.monitorsAttached.length}${report.monitorsAttached.length > 0 ? ` (${report.monitorsAttached.join(', ')})` : ''}`)
  log(`  orphan tokens dropped:      ${report.orphans.length}${report.orphans.length > 0 ? ` (monitors ${report.orphans.map(o => o.monitor_id).join(', ')})` : ''}`)
  log(`  agent rows read:            ${report.totals.read}`)
  log(`  samples inserted:           ${report.dryRun ? report.totals.convertible : report.totals.inserted}`)
  log(`  metric-less rows dropped:   ${report.totals.metricless}`)
  log(`  incidents resolved:         ${report.incidentsResolved.length}`)
  log(`  agent rows remaining:       ${report.agentRowsRemaining}${report.final ? ' (must be 0 with --final)' : ''}`)
  if (report.agentRowsWithoutToken.length > 0)
    log(`  agent rows on token-less monitors (not swept): ${report.agentRowsWithoutToken.map(r => `monitor ${r.monitor_id}: ${r.rows}`).join('; ')}`)
  log(`  tokens without a server:    ${report.unattachedTokens}${report.dryRun ? ' (before the run)' : ' (must be 0)'}`)
}

// ---------------------------------------------------------------------------
// Reverse: servers:rollback
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  yes?: boolean
  now?: string
  log?: (line: string) => void
}

export interface RollbackReport {
  entryStartedAt: string
  serversDeleted: number[]
  monitorsDetached: number
  tokensRestored: number
  samplesRestored: number
  metriclessRestored: number
  incidentsReopened: number[]
  serverIncidentsResolved: number
  entriesRemaining: number
}

async function restoreSamplesBatch(serverId: number, sampleIds: number[], monitorFor: (sampleId: number) => number, restoredCounter: { n: number }): Promise<void> {
  await transaction(async (tx) => {
    const samples = await tx.selectFrom('server_metric_samples')
      .where('server_id', '=', serverId).where('id', 'in', sampleIds)
      .selectAll().orderBy('id', 'asc').execute() as unknown as SampleRow[]
    if (samples.length === 0)
      return
    const rows = samples.map(sample => agentRowFromSample(sample, monitorFor(Number(sample.id))))
    const before = Number(await tx.selectFrom('check_results').where('region', '=', 'agent').count())
    await tx.insertInto('check_results').values(rows as never).execute()
    const after = Number(await tx.selectFrom('check_results').where('region', '=', 'agent').count())
    if (after - before !== rows.length)
      throw new Error(`servers:rollback: server ${serverId} batch restored ${after - before} of ${rows.length} rows — aborting before deleting any sample`)
    await tx.deleteFrom('server_metric_samples').where('id', 'in', samples.map(s => Number(s.id))).execute()
    restoredCounter.n += rows.length
  })
}

export async function runServersRollback(options: RollbackOptions = {}): Promise<RollbackReport> {
  const now = options.now ?? new Date().toISOString()
  const log = options.log ?? ((line: string) => console.log(line))

  if (options.yes !== true)
    throw new Error('servers:rollback rewrites check_results, servers, monitors and incidents — re-run with --yes')

  const journal = readJournal()
  const index = journal.map((e, i) => [e, i] as const).filter(([e]) => !e.rolled_back_at).map(([, i]) => i).pop()
  if (index === undefined)
    throw new Error(`servers:rollback: no un-rolled-back entry in ${journalPath()} — nothing to reverse`)
  const entry = journal[index]
  const outcome: JournalOutcome = entry.outcome ?? 'complete'
  log(`servers:rollback at ${now}: reversing the run started ${entry.started_at} (${entry.servers_created.length} server(s) created, ${entry.samples_moved.length} sweep(s), ${entry.orphan_tokens_dropped.length} token(s) dropped, ${entry.incidents_resolved.length} incident(s) resolved)`)
  if (outcome === 'aborted')
    log(`  that run ABORTED at ${entry.finished_at} (${entry.error ?? 'no error recorded'}); reversing what it had written up to then`)
  else if (outcome === 'running')
    log(`  that run never recorded finishing (last journaled ${entry.finished_at}) — it died, or is still running; make sure no servers:migrate process is alive before continuing. Reversing what it had written up to then`)

  // Refuse when a server this entry created has samples newer than the run:
  // deleting the server would lose them. Sweep-only entries leave the server
  // in place, so their servers may keep receiving pushes.
  const blocked: { id: number, newest: string, count: number }[] = []
  for (const server of entry.servers_created) {
    const base = () => db.selectFrom('server_metric_samples').where('server_id', '=', server.id).where('sampled_at', '>', entry.finished_at)
    const count = Number(await base().count())
    if (count > 0)
      blocked.push({ id: server.id, newest: String(await base().max('sampled_at')), count })
  }
  if (blocked.length > 0) {
    const detail = blocked.map(b => `server ${b.id}: ${b.count} sample(s) after ${entry.finished_at}, newest ${b.newest}`).join('; ')
    throw new Error(`servers:rollback: refusing — ${detail}. Those samples arrived through the Server ingest after the migration and would be lost. Either stop the agents pushing to those servers and delete their post-migration samples by hand (DELETE FROM server_metric_samples WHERE server_id = ? AND sampled_at > '${entry.finished_at}') once you have decided you do not need them, then re-run servers:rollback --yes; or keep the Server model and do not roll back.`)
  }

  const report: RollbackReport = {
    entryStartedAt: entry.started_at,
    serversDeleted: [],
    monitorsDetached: 0,
    tokensRestored: 0,
    samplesRestored: 0,
    metriclessRestored: 0,
    incidentsReopened: [],
    serverIncidentsResolved: 0,
    entriesRemaining: 0,
  }
  const createdIds = new Set(entry.servers_created.map(s => s.id))

  // Samples back to check_results, newest sweep first, in the batched,
  // count-asserted shape of the forward move.
  const restored = { n: 0 }
  for (const sweep of [...entry.samples_moved].reverse()) {
    const runs = sweep.sample_runs
    const monitorFor = (sampleId: number): number => {
      for (const [monitorId, from, to] of runs) {
        if (sampleId >= from && sampleId <= to)
          return monitorId
      }
      return Math.min(...sweep.monitor_ids)
    }
    const ids: number[] = []
    for (const [, from, to] of runs) {
      for (let id = from; id <= to; id++)
        ids.push(id)
    }
    for (let i = 0; i < ids.length; i += BATCH)
      await restoreSamplesBatch(sweep.server_id, ids.slice(i, i + BATCH), monitorFor, restored)

    if (sweep.metricless_rows.length > 0) {
      await transaction(async (tx) => {
        const before = Number(await tx.selectFrom('check_results').where('region', '=', 'agent').count())
        await tx.insertInto('check_results').values(sweep.metricless_rows.map(row => ({ ...row, uuid: row.uuid ?? crypto.randomUUID() })) as never).execute()
        const after = Number(await tx.selectFrom('check_results').where('region', '=', 'agent').count())
        if (after - before !== sweep.metricless_rows.length)
          throw new Error(`servers:rollback: restored ${after - before} of ${sweep.metricless_rows.length} metric-less rows for server ${sweep.server_id}`)
      })
      report.metriclessRestored += sweep.metricless_rows.length
    }
    log(`  server ${sweep.server_id}: restored ${ids.length} sample(s) and ${sweep.metricless_rows.length} metric-less row(s) to monitors ${sweep.monitor_ids.join(', ')}`)
  }
  report.samplesRestored = restored.n

  // Servers this entry created: anything still on them (samples the ingest
  // wrote between phase A and the end of the run) goes back to the lowest-id
  // monitor, their server incidents are closed, monitors detached, row gone.
  for (const server of entry.servers_created) {
    const lowest = Math.min(...server.monitor_ids)
    for (;;) {
      const rest = (await db.selectFrom('server_metric_samples').where('server_id', '=', server.id).select(['id']).orderBy('id', 'asc').limit(BATCH).execute() as unknown as { id: number }[]).map(r => Number(r.id))
      if (rest.length === 0)
        break
      await restoreSamplesBatch(server.id, rest, () => lowest, restored)
    }

    const open = await db.selectFrom('incidents').where('server_id', '=', server.id).where('status', '!=', 'resolved').select(['id']).execute() as unknown as { id: number }[]
    for (const incident of open) {
      await resolveIncidentQuietly(Number(incident.id), ROLLBACK_SERVER_RESOLVED_MESSAGE, now)
      report.serverIncidentsResolved++
    }

    await transaction(async (tx) => {
      const attached = Number(await tx.selectFrom('monitors').where('server_id', '=', server.id).count())
      await tx.updateTable('monitors').set({ server_id: null } as never).where('server_id', '=', server.id).execute()
      await tx.deleteFrom('servers').where('id', '=', server.id).execute()
      report.monitorsDetached += attached
    })
    report.serversDeleted.push(server.id)
    log(`  deleted server ${server.id} "${server.name}" and detached monitors ${server.monitor_ids.join(', ')}`)
  }
  report.samplesRestored = restored.n

  for (const dropped of entry.orphan_tokens_dropped) {
    await withLockRetry(() => db.updateTable('monitors').set({ metrics_token: dropped.token } as never).where('id', '=', dropped.monitor_id).execute(), `restore token on ${dropped.monitor_id}`)
    report.tokensRestored++
  }

  for (const id of entry.incidents_resolved) {
    const exists = await db.selectFrom('incidents').where('id', '=', id).select(['id']).executeTakeFirst()
    if (!exists)
      continue
    await withLockRetry(() => db.updateTable('incidents').set({ status: 'investigating', resolved_at: null, updated_at: now } as never).where('id', '=', id).execute(), `reopen incident ${id}`)
    await postIncidentNote(id, ROLLBACK_REOPENED_MESSAGE, 'investigating', now)
    report.incidentsReopened.push(id)
  }

  journal[index] = { ...entry, rolled_back_at: now }
  writeJournal(journal)
  report.entriesRemaining = journal.filter(e => !e.rolled_back_at).length

  log('')
  log('servers:rollback report')
  log(`  run reversed:               started ${entry.started_at}`)
  log(`  servers deleted:            ${report.serversDeleted.length}${report.serversDeleted.length > 0 ? ` (${report.serversDeleted.join(', ')})` : ''}${createdIds.size === 0 ? ' (sweep-only entry, servers kept)' : ''}`)
  log(`  monitors detached:          ${report.monitorsDetached}`)
  log(`  tokens restored:            ${report.tokensRestored}`)
  log(`  samples restored to check_results: ${report.samplesRestored}`)
  log(`  metric-less rows restored:  ${report.metriclessRestored}`)
  log(`  incidents reopened:         ${report.incidentsReopened.length}`)
  log(`  server incidents resolved:  ${report.serverIncidentsResolved}`)
  log(`  journal entries still applied: ${report.entriesRemaining}${report.entriesRemaining > 0 ? ' — run servers:rollback --yes again to reverse the previous run' : ''}`)

  return report
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface MigrateCliOptions { dryRun: boolean, final: boolean }
interface RollbackCliOptions { yes: boolean }

export default function (cli: CLI) {
  cli
    .command('servers:migrate', 'Backfill Servers from monitor metrics tokens and move agent samples out of check_results')
    .option('--dry-run', 'Print every count and write nothing', { default: false })
    .option('--final', 'Also assert that no region=agent row remains in check_results', { default: false })
    .action(async (options: MigrateCliOptions) => {
      try {
        await runServersMigrate({ dryRun: options.dryRun, final: options.final })
        console.log(options.dryRun ? '✓ Dry-run complete.' : '✓ servers:migrate complete.')
        process.exit(ExitCode.Success)
      }
      catch (error) {
        console.error(`✗ servers:migrate failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
    })

  cli
    .command('servers:rollback', 'Reverse the newest servers:migrate run recorded in storage/framework/servers-migrate.json')
    .option('--yes', 'Confirm the rewrite of check_results, servers, monitors and incidents', { default: false })
    .action(async (options: RollbackCliOptions) => {
      try {
        await runServersRollback({ yes: options.yes })
        console.log('✓ servers:rollback complete.')
        process.exit(ExitCode.Success)
      }
      catch (error) {
        console.error(`✗ servers:rollback failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
    })
}
