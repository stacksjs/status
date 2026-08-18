import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import CheckStaleMetrics from '../../app/Jobs/CheckStaleMetrics'
import Incident from '../../app/Models/Incident'
import Monitor from '../../app/Models/Monitor'

// Server-metrics threshold alerting + missed-push (stacksjs/status#1).
const TEAM = 90600

async function makeMetricsMonitor(config: Record<string, unknown> = {}): Promise<{ id: number, token: string }> {
  const token = `mtok-${TEAM}-${Math.floor(performance.now() * 1000)}`
  const m = await Monitor.create({
    team_id: TEAM, name: 'metrics-host', url: 'https://host.example', type: 'uptime',
    status: 'up', enabled: true, reports_metrics: true, metrics_token: token, config: JSON.stringify(config),
  })
  return { id: m.id, token }
}

function push(token: string, body: Record<string, number | string>) {
  return featureTest().post(`/api/agent/${token}/metrics`, body)
}

async function statusOf(id: number): Promise<string> {
  const m = await Monitor.find(id)
  return String(m!.status)
}
async function openIncidents(id: number) {
  return db.selectFrom('incidents').where('monitor_id', '=', id).where('status', '!=', 'resolved').selectAll().execute()
}

const created: number[] = []

describe('Server metrics (threshold alerting)', () => {
  afterAll(async () => {
    for (const id of created) {
      // incident_updates FK -> incidents, so clear them before incidents.
      const incs = await db.selectFrom('incidents').where('monitor_id', '=', id).select(['id']).execute() as Array<{ id: number }>
      for (const inc of incs)
        await db.deleteFrom('incident_updates').where('incident_id', '=', inc.id).execute()
      await db.deleteFrom('incidents').where('monitor_id', '=', id).execute()
      await db.deleteFrom('check_results').where('monitor_id', '=', id).execute()
      await db.deleteFrom('monitors').where('id', '=', id).execute()
    }
  })

  test('an unknown token is rejected 404', async () => {
    const res = await push('nope-not-a-token', { cpuPercent: 10, ramPercent: 10, ramUsedMb: 1, ramTotalMb: 2 })
    expect(res.status).toBe(404)
  })

  test('an out-of-range sample is rejected 422', async () => {
    const { id, token } = await makeMetricsMonitor()
    created.push(id)
    const res = await push(token, { cpuPercent: 150, ramPercent: 10, ramUsedMb: 1, ramTotalMb: 2 })
    expect(res.status).toBe(422)
  })

  test('a healthy sample stays up and opens no incident', async () => {
    const { id, token } = await makeMetricsMonitor()
    created.push(id)
    const res = await push(token, { cpuPercent: 20, ramPercent: 30, ramUsedMb: 3000, ramTotalMb: 16000 })
    expect(res.status).toBe(200)
    expect(await statusOf(id)).toBe('up')
    expect(await openIncidents(id)).toHaveLength(0)
  })

  test('a CPU breach marks down and opens exactly one incident; recovery resolves it', async () => {
    const { id, token } = await makeMetricsMonitor()
    created.push(id)

    // breach (default cpu threshold 90)
    await push(token, { cpuPercent: 96, ramPercent: 40, ramUsedMb: 6000, ramTotalMb: 16000 })
    expect(await statusOf(id)).toBe('down')
    expect(await openIncidents(id)).toHaveLength(1)

    // still breaching — no duplicate incident
    await push(token, { cpuPercent: 94, ramPercent: 40, ramUsedMb: 6000, ramTotalMb: 16000 })
    expect(await openIncidents(id)).toHaveLength(1)

    // recovery resolves it
    const res = await push(token, { cpuPercent: 30, ramPercent: 40, ramUsedMb: 6000, ramTotalMb: 16000 })
    expect(res.status).toBe(200)
    expect(await statusOf(id)).toBe('up')
    expect(await openIncidents(id)).toHaveLength(0)
  })

  test('custom thresholds from config are honored; disk only alerts when reported', async () => {
    const { id, token } = await makeMetricsMonitor({ cpuThreshold: 50, diskThreshold: 80 })
    created.push(id)

    // cpu 60 breaches the custom 50 threshold
    await push(token, { cpuPercent: 60, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000 })
    expect(await statusOf(id)).toBe('down')
    await push(token, { cpuPercent: 10, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000 })
    expect(await statusOf(id)).toBe('up')

    // disk breach only when diskPercent is sent
    await push(token, { cpuPercent: 10, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, diskPercent: 85 })
    expect(await statusOf(id)).toBe('down')
  })

  test('missed-push job marks a stale metrics monitor down and opens an incident', async () => {
    const { id } = await makeMetricsMonitor({ metricsWindowSeconds: 60 })
    created.push(id)

    // last agent push 10 minutes ago -> stale (window 60s)
    const old = new Date(Date.now() - 600_000).toISOString()
    await db.insertInto('check_results').values({ monitor_id: id, status: 'up', message: 'old', region: 'agent', checked_at: old } as never).execute()

    await CheckStaleMetrics.handle()
    expect(await statusOf(id)).toBe('down')
    expect(await openIncidents(id)).toHaveLength(1)

    // a fresh push recovers it
    const { token } = { token: (await Monitor.find(id))!.metrics_token as string }
    await push(token, { cpuPercent: 10, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000 })
    expect(await statusOf(id)).toBe('up')
    expect(await openIncidents(id)).toHaveLength(0)
  })

  test('a recent-push metrics monitor is NOT flagged by the missed-push job', async () => {
    const { id, token } = await makeMetricsMonitor({ metricsWindowSeconds: 300 })
    created.push(id)
    await push(token, { cpuPercent: 10, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000 })
    await CheckStaleMetrics.handle()
    expect(await statusOf(id)).toBe('up')
  })

  // Several machines reporting to one monitor. Both SDKs send `host` with
  // every sample; these pin what the ingest does with it.

  test('a sample without a host still works, and records the default one', async () => {
    // Agents predating the field, and the curl snippet on the monitor page.
    const { id, token } = await makeMetricsMonitor()
    created.push(id)

    const res = await push(token, { cpuPercent: 20, ramPercent: 30, ramUsedMb: 3000, ramTotalMb: 16000 })

    expect(await res.json()).toMatchObject({ success: true, host: 'default', status: 'up' })
    expect(await statusOf(id)).toBe('up')
  })

  test('one breaching host takes the monitor down and names itself in the incident', async () => {
    const { id, token } = await makeMetricsMonitor({ cpuThreshold: 90 })
    created.push(id)

    await push(token, { cpuPercent: 10, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-01' })
    await push(token, { cpuPercent: 96, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-02' })

    expect(await statusOf(id)).toBe('down')
    const incidents = await openIncidents(id)
    expect(incidents).toHaveLength(1)
    // Without the host, "CPU 96% ≥ 90%" does not say which box to open a
    // shell on — the first thing the person being woken up needs.
    expect(String(incidents[0]!.cause)).toContain('web-02')
  })

  test('a healthy push from another host does not clear a breach', async () => {
    // The flapping the aggregation exists to prevent: web-01 reporting fine
    // every minute would otherwise resolve web-02's incident, and web-02's
    // next sample would reopen it, once a minute, forever.
    const { id, token } = await makeMetricsMonitor({ cpuThreshold: 90 })
    created.push(id)

    await push(token, { cpuPercent: 96, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-02' })
    expect(await statusOf(id)).toBe('down')

    const res = await push(token, { cpuPercent: 5, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-01' })

    expect(await statusOf(id)).toBe('down')
    expect(await openIncidents(id)).toHaveLength(1)
    // ...but that host is told its own sample was fine, so an agent can tell
    // whether it is the problem.
    expect(await res.json()).toMatchObject({ status: 'down', sampleStatus: 'up', host: 'web-01' })
  })

  test('the monitor recovers only when the breaching host itself recovers', async () => {
    const { id, token } = await makeMetricsMonitor({ cpuThreshold: 90 })
    created.push(id)

    await push(token, { cpuPercent: 96, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-02' })
    await push(token, { cpuPercent: 5, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-01' })
    expect(await statusOf(id)).toBe('down')

    await push(token, { cpuPercent: 12, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-02' })

    expect(await statusOf(id)).toBe('up')
    expect(await openIncidents(id)).toHaveLength(0)
  })

  test('hostnames differing only in case are one host, not two', async () => {
    const { id, token } = await makeMetricsMonitor({ cpuThreshold: 90 })
    created.push(id)

    await push(token, { cpuPercent: 96, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'Web-01' })
    const res = await push(token, { cpuPercent: 4, ramPercent: 10, ramUsedMb: 1000, ramTotalMb: 16000, host: 'web-01' })

    expect(await res.json()).toMatchObject({ hosts: 1 })
    expect(await statusOf(id)).toBe('up')
  })
})
