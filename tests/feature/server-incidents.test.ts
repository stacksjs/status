import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import CheckStaleMetrics from '../../app/Jobs/CheckStaleMetrics'
import CheckStaleServers, { claimServerStatus } from '../../app/Jobs/CheckStaleServers'
import MaintenanceWindow from '../../app/Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../app/Models/MaintenanceWindowMonitor'
import Monitor from '../../app/Models/Monitor'

/**
 * The Server incident state machine (SERVER-MODEL-SPEC §4.1/§4.3).
 *
 * Everything here is about the one property the pre-Server code could not
 * hold: at most ONE open incident of each kind per box, opened and resolved
 * from the box's STATE rather than from a status edge. Production ran the
 * edge version and accumulated 45 simultaneously open "host threshold
 * breached" incidents — one monitor alone held five — because the cause
 * string it deduped on embeds live percentages and therefore never matched
 * twice, and because monitors.status had two writers so the recovery edge was
 * routinely spent before the ingest saw it.
 *
 * Fixtures insert `servers` rows through the query builder: `status` and
 * `last_sample_at` are deliberately not fillable, and several cases here need
 * to start from a state only the ingest or the tick can otherwise produce.
 */

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM = 90601

interface Fixture { id: number, token: string }

const WINDOW = 300

async function makeServer(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const token = `stok-${TEAM}-${Math.floor(performance.now() * 1000)}-${Math.floor(Math.random() * 1e6)}`
  await db.insertInto('servers').values({
    team_id: TEAM,
    name: 'box-01',
    metrics_token: token,
    cpu_threshold: 90,
    ram_threshold: 90,
    disk_threshold: 85,
    metrics_window_seconds: WINDOW,
    status: 'unknown',
    last_sample_at: null,
    uuid: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    ...overrides,
  } as never).execute()

  const row = await db.selectFrom('servers').where('metrics_token', '=', token).select(['id']).executeTakeFirst()
  return { id: Number(row!.id), token }
}

async function attachMonitor(serverId: number, name: string): Promise<any> {
  return Monitor.create({
    teamId: TEAM,
    name,
    url: `https://${name}.example.com`,
    type: 'uptime',
    status: 'up',
    enabled: true,
    serverId,
  } as never)
}

async function addSample(serverId: number, host: string, breaches: string[], sampledAt: string): Promise<void> {
  await db.insertInto('server_metric_samples').values({
    server_id: serverId,
    host,
    cpu_percent: breaches.length > 0 ? 96 : 12,
    ram_percent: 40,
    ram_used_mb: 6400,
    ram_total_mb: 16000,
    disk_percent: null,
    breaches: JSON.stringify(breaches),
    sampled_at: sampledAt,
    created_at: sampledAt,
  } as never).execute()
}

async function insertIncident(serverId: number, marker: Record<string, unknown>, cause = 'seeded'): Promise<number> {
  const startedAt = new Date().toISOString()
  await db.insertInto('incidents').values({
    monitor_id: null,
    server_id: serverId,
    started_at: startedAt,
    cause,
    status: 'investigating',
    impacted_checks: JSON.stringify([marker]),
    uuid: crypto.randomUUID(),
    created_at: startedAt,
  } as never).execute()

  const row = await db.selectFrom('incidents').where('server_id', '=', serverId)
    .orderBy('id', 'desc').select(['id']).executeTakeFirst()
  return Number(row!.id)
}

function push(token: string, body: Record<string, number | string>) {
  return featureTest().post(`/api/agent/${token}/metrics`, body)
}

const hot = (host?: string) => ({ cpuPercent: 96, ramPercent: 40, ramUsedMb: 6000, ramTotalMb: 16000, ...(host ? { host } : {}) })
const cool = (host?: string) => ({ cpuPercent: 12, ramPercent: 40, ramUsedMb: 6000, ramTotalMb: 16000, ...(host ? { host } : {}) })

async function statusOf(id: number): Promise<string> {
  const row = await db.selectFrom('servers').where('id', '=', id).select(['status']).executeTakeFirst()
  return String(row!.status)
}

async function incidentsOf(id: number, openOnly = true): Promise<any[]> {
  const query = db.selectFrom('incidents').where('server_id', '=', id)
  return (openOnly ? query.where('status', '!=', 'resolved') : query).selectAll().execute() as Promise<any[]>
}

function markerOf(incident: any): any {
  return JSON.parse(String(incident.impacted_checks || '[]'))[0]
}

async function updatesOf(incidentId: number): Promise<any[]> {
  return db.selectFrom('incident_updates').where('incident_id', '=', incidentId).selectAll().execute() as Promise<any[]>
}

async function ageLastSample(serverId: number, ms: number): Promise<void> {
  await db.updateTable('servers')
    .set({ last_sample_at: new Date(Date.now() - ms).toISOString() } as never)
    .where('id', '=', serverId).execute()
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

async function cleanup(): Promise<void> {
  for (const win of await MaintenanceWindow.where('team_id', TEAM).get()) {
    for (const link of await MaintenanceWindowMonitor.where('maintenance_window_id', win.id).get())
      await link.delete()
    await win.delete()
  }

  const servers = await db.selectFrom('servers').where('team_id', '=', TEAM).select(['id']).execute() as Array<{ id: number }>
  for (const server of servers) {
    const incidents = await db.selectFrom('incidents').where('server_id', '=', server.id).select(['id']).execute() as Array<{ id: number }>
    for (const incident of incidents)
      await db.deleteFrom('incident_updates').where('incident_id', '=', incident.id).execute()
    await db.deleteFrom('incidents').where('server_id', '=', server.id).execute()
    await db.deleteFrom('server_metric_samples').where('server_id', '=', server.id).execute()
  }

  for (const monitor of await Monitor.where('team_id', TEAM).get()) {
    const incidents = await db.selectFrom('incidents').where('monitor_id', '=', monitor.id).select(['id']).execute() as Array<{ id: number }>
    for (const incident of incidents)
      await db.deleteFrom('incident_updates').where('incident_id', '=', incident.id).execute()
    await db.deleteFrom('incidents').where('monitor_id', '=', monitor.id).execute()
    await db.deleteFrom('check_results').where('monitor_id', '=', monitor.id).execute()
    await db.deleteFrom('monitors').where('id', '=', monitor.id).execute()
  }

  await db.deleteFrom('servers').where('team_id', '=', TEAM).execute()
}

describe('Server incidents (state machine)', () => {
  beforeAll(cleanup)
  afterEach(cleanup)

  test('one hot box is one incident, however many sites sit on it', async () => {
    const server = await makeServer()
    const monitors = [
      await attachMonitor(server.id, 'site-a'),
      await attachMonitor(server.id, 'site-b'),
      await attachMonitor(server.id, 'site-c'),
    ]

    await push(server.token, hot('web-01'))

    expect(await statusOf(server.id)).toBe('hot')
    const open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(markerOf(open[0]).type).toBe('server_hot')
    expect(open[0].monitor_id).toBeNull()
    expect(Number(open[0].server_id)).toBe(server.id)

    // The box being busy says nothing about whether the sites answer.
    for (const monitor of monitors) {
      const after = await Monitor.find(monitor.id)
      expect(after!.status).toBe('up')
      expect(after!.last_checked_at).toBeFalsy()
      expect(Number(after!.consecutive_failures ?? 0)).toBe(0)
    }
  })

  test('the same breach set pushed again neither stacks nor posts an update', async () => {
    const server = await makeServer()
    await attachMonitor(server.id, 'site-a')

    await push(server.token, hot('web-01'))
    const first = (await incidentsOf(server.id))[0]
    expect(await updatesOf(first.id)).toHaveLength(0)

    await push(server.token, hot('web-01'))

    const open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(Number(open[0].id)).toBe(Number(first.id))
    // Dedup is by marker kind, and the cause (which embeds live percentages)
    // is only rewritten when the breach SET changes — it has not.
    expect(await updatesOf(first.id)).toHaveLength(0)
  })

  test('a second breaching host updates the one incident in place, with one update', async () => {
    const server = await makeServer()
    await attachMonitor(server.id, 'site-a')

    await push(server.token, hot('web-01'))
    const first = (await incidentsOf(server.id))[0]

    await push(server.token, hot('web-02'))

    const open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(Number(open[0].id)).toBe(Number(first.id))
    expect(String(open[0].cause)).toContain('web-02')
    expect(markerOf(open[0]).hosts.map((h: any) => h.host)).toEqual(['web-01', 'web-02'])
    const updates = await updatesOf(first.id)
    expect(updates).toHaveLength(1)
    expect(String(updates[0].message)).toContain('Breaches changed')
    // An in-place update is not a second page: only created / resolved notify.
    expect(String(updates[0].status)).not.toBe('resolved')
  })

  test('a healthy push resolves the open breach with one update', async () => {
    const server = await makeServer()
    await attachMonitor(server.id, 'site-a')

    await push(server.token, hot('web-01'))
    const opened = (await incidentsOf(server.id))[0]

    await push(server.token, cool('web-01'))

    expect(await statusOf(server.id)).toBe('healthy')
    expect(await incidentsOf(server.id)).toHaveLength(0)
    const updates = await updatesOf(opened.id)
    expect(updates).toHaveLength(1)
    expect(String(updates[0].status)).toBe('resolved')
    // posted_at is written from the camelCase attribute the model declares;
    // the pre-Server ingest passed snake_case here and it read as missing.
    expect(updates[0].posted_at).toBeTruthy()
  })

  test('a push writes zero check_results rows for any attached monitor', async () => {
    // The agent-region voting bug, pinned: a sample is not a check and must
    // never reach the table uptime.ts and consensusStatus count votes from.
    const server = await makeServer()
    const monitor = await attachMonitor(server.id, 'site-a')

    await push(server.token, cool('web-01'))

    const results = await db.selectFrom('check_results').where('monitor_id', '=', monitor.id).selectAll().execute()
    expect(results).toHaveLength(0)
    const samples = await db.selectFrom('server_metric_samples').where('server_id', '=', server.id).selectAll().execute()
    expect(samples).toHaveLength(1)
  })

  test('state not edge (push): a healthy push resolves a breach it never saw open', async () => {
    // The post-migration / crashed-ingest shape: status already healthy with a
    // server_hot still open. An edge-triggered resolve never fires here, which
    // is how production incidents sat open against a green monitor.
    const server = await makeServer({ status: 'healthy', last_sample_at: iso(-1000) })
    await attachMonitor(server.id, 'site-a')
    const seeded = await insertIncident(server.id, { type: 'server_hot', hosts: [{ host: 'web-01', breaches: ['CPU 96% ≥ 90%'] }] })

    await push(server.token, cool('web-01'))

    expect(await incidentsOf(server.id)).toHaveLength(0)
    expect(await updatesOf(seeded)).toHaveLength(1)
  })

  test('state not edge (tick): a hot box with nothing open gets exactly one incident', async () => {
    const server = await makeServer({ status: 'hot', last_sample_at: iso(-10_000) })
    await attachMonitor(server.id, 'site-a')
    await addSample(server.id, 'web-01', ['CPU 96% ≥ 90%'], iso(-10_000))

    await CheckStaleServers.handle()

    let open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(markerOf(open[0]).type).toBe('server_hot')
    const first = Number(open[0].id)

    // A second tick with the same state is a no-op.
    await CheckStaleServers.handle()
    open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(await updatesOf(first)).toHaveLength(0)

    // A second host starts breaching: the marker is rewritten in place.
    await addSample(server.id, 'web-02', ['CPU 99% ≥ 90%'], iso(-1000))
    await CheckStaleServers.handle()

    open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(Number(open[0].id)).toBe(first)
    expect(markerOf(open[0]).hosts.map((h: any) => h.host)).toEqual(['web-01', 'web-02'])
    expect(await updatesOf(first)).toHaveLength(1)
  })

  test('stale-hot self-heals: the breaching host aged out, another kept pushing', async () => {
    const server = await makeServer({ status: 'hot', last_sample_at: iso(-5000) })
    await attachMonitor(server.id, 'site-a')
    await addSample(server.id, 'web-01', ['CPU 96% ≥ 90%'], iso(-(WINDOW + 60) * 1000))
    await addSample(server.id, 'web-02', [], iso(-5000))
    const seeded = await insertIncident(server.id, { type: 'server_hot', hosts: [{ host: 'web-01', breaches: ['CPU 96% ≥ 90%'] }] })

    await CheckStaleServers.handle()

    expect(await statusOf(server.id)).toBe('healthy')
    expect(await incidentsOf(server.id)).toHaveLength(0)
    expect(await updatesOf(seeded)).toHaveLength(1)
  })

  test('a widened window un-quiets a box without waiting for a push', async () => {
    // The state DashboardUpdateServerAction produces: quiet, an open
    // server_silent, and a window that now covers the last sample.
    const server = await makeServer({ status: 'quiet', last_sample_at: iso(-240_000), metrics_window_seconds: 600 })
    await attachMonitor(server.id, 'site-a')
    await addSample(server.id, 'web-01', [], iso(-240_000))
    const seeded = await insertIncident(server.id, { type: 'server_silent', reason: 'missed_push', windowSeconds: 300 })

    await CheckStaleServers.handle()

    expect(await statusOf(server.id)).toBe('healthy')
    expect(await incidentsOf(server.id)).toHaveLength(0)
    expect(await updatesOf(seeded)).toHaveLength(1)
  })

  test('hot then quiet then hot again does not stack a second breach incident', async () => {
    const server = await makeServer()
    await attachMonitor(server.id, 'site-a')

    await push(server.token, hot('web-01'))
    const breach = Number((await incidentsOf(server.id))[0].id)

    // The agent stops pushing.
    await ageLastSample(server.id, (WINDOW + 60) * 1000)
    await CheckStaleServers.handle()

    expect(await statusOf(server.id)).toBe('quiet')
    let open = await incidentsOf(server.id)
    expect(open.map(markerOf).map((m: any) => m.type).sort()).toEqual(['server_hot', 'server_silent'])

    // It comes back, still hot.
    await push(server.token, hot('web-01'))

    expect(await statusOf(server.id)).toBe('hot')
    open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(Number(open[0].id)).toBe(breach)
  })

  test('a silent agent opens one incident however many ticks pass, and a push clears it', async () => {
    const server = await makeServer({ status: 'healthy', last_sample_at: iso(-(WINDOW + 60) * 1000) })
    await attachMonitor(server.id, 'site-a')

    await CheckStaleServers.handle()
    await CheckStaleServers.handle()

    expect(await statusOf(server.id)).toBe('quiet')
    const open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    const marker = markerOf(open[0])
    expect(marker.type).toBe('server_silent')
    expect(marker.reason).toBe('missed_push')
    expect(marker.windowSeconds).toBe(WINDOW)
    expect(String(open[0].cause)).toContain(`within ${WINDOW}s`)

    await push(server.token, cool('web-01'))

    expect(await statusOf(server.id)).toBe('healthy')
    expect(await incidentsOf(server.id)).toHaveLength(0)
    expect(await updatesOf(Number(open[0].id))).toHaveLength(1)
  })

  test('a box that has never pushed is not a box that went quiet', async () => {
    // A server created in the dashboard an hour ago while the operator is
    // still running the installer must not page.
    const server = await makeServer({ status: 'unknown', last_sample_at: null, created_at: iso(-3600_000) })
    await attachMonitor(server.id, 'site-a')

    await CheckStaleServers.handle()

    expect(await statusOf(server.id)).toBe('unknown')
    expect(await incidentsOf(server.id)).toHaveLength(0)
  })

  test('a stale baseline claims nothing: the push that landed first wins', async () => {
    // The compare-and-set the tick writes every status through. The ingest
    // runs in the web process and this job in the queue worker, and SQLite's
    // per-process transaction serialisation does not order the two; if a push
    // moved last_sample_at between this tick's read and its write, the UPDATE
    // must match zero rows and the tick must say nothing about the box.
    // Also pins the affected-row field name the job reads (numUpdatedRows).
    const fresh = iso(0)
    const server = await makeServer({ status: 'healthy', last_sample_at: fresh })

    expect(await claimServerStatus(server.id, iso(-999_000), 'quiet', iso(0))).toBe(false)
    expect(await statusOf(server.id)).toBe('healthy')

    expect(await claimServerStatus(server.id, fresh, 'quiet', iso(0))).toBe(true)
    expect(await statusOf(server.id)).toBe('quiet')
  })

  test('a migrated monitor is watched by the server tick alone, never by both', async () => {
    // Coexistence for ship step 2: CheckStaleMetrics stays scheduled for the
    // monitors the backfill has not moved yet, but its work set gains
    // whereNull('server_id') so an attached monitor cannot also raise a
    // monitor-keyed missed-push incident for the same silent agent.
    const server = await makeServer({ status: 'healthy', last_sample_at: iso(-(WINDOW + 60) * 1000) })
    const monitor = await Monitor.create({
      teamId: TEAM,
      name: 'migrated-site',
      url: 'https://migrated.example.com',
      type: 'uptime',
      status: 'up',
      enabled: true,
      reportsMetrics: true,
      metricsToken: `legacy-${TEAM}-${Math.floor(performance.now() * 1000)}`,
      config: JSON.stringify({ metricsWindowSeconds: 60 }),
      serverId: server.id,
    } as never)
    // The stale agent row the old job would have keyed its baseline off.
    await db.insertInto('check_results').values({
      monitor_id: monitor.id,
      status: 'up',
      message: 'old',
      region: 'agent',
      checked_at: iso(-600_000),
    } as never).execute()

    await CheckStaleMetrics.handle()

    const monitorIncidents = await db.selectFrom('incidents').where('monitor_id', '=', monitor.id).selectAll().execute()
    expect(monitorIncidents).toHaveLength(0)
    expect((await Monitor.find(monitor.id))!.status).toBe('up')

    // The box's own tick is the one that raises it, once.
    await CheckStaleServers.handle()
    const open = await incidentsOf(server.id)
    expect(open).toHaveLength(1)
    expect(markerOf(open[0]).type).toBe('server_silent')
  })

  test('maintenance suppresses the incident only when every site on the box is covered', async () => {
    const covered = await makeServer()
    const a = await attachMonitor(covered.id, 'site-a')
    const b = await attachMonitor(covered.id, 'site-b')
    const win = await MaintenanceWindow.create({ teamId: TEAM, title: 'Planned work', startsAt: iso(-3600_000), endsAt: iso(3600_000), status: 'active' })
    await MaintenanceWindowMonitor.create({ maintenance_window_id: win.id, monitor_id: a.id })
    await MaintenanceWindowMonitor.create({ maintenance_window_id: win.id, monitor_id: b.id })

    await push(covered.token, hot('web-01'))

    expect(await statusOf(covered.id)).toBe('hot')
    expect(await incidentsOf(covered.id)).toHaveLength(0)

    // One site still being watched means somebody wants to hear the box is hot.
    const partial = await makeServer()
    const c = await attachMonitor(partial.id, 'site-c')
    await attachMonitor(partial.id, 'site-d')
    const win2 = await MaintenanceWindow.create({ teamId: TEAM, title: 'Planned work', startsAt: iso(-3600_000), endsAt: iso(3600_000), status: 'active' })
    await MaintenanceWindowMonitor.create({ maintenance_window_id: win2.id, monitor_id: c.id })

    await push(partial.token, hot('web-01'))

    expect(await incidentsOf(partial.id)).toHaveLength(1)
  })
})
