import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import PruneOldServerMetricSamples from '../../app/Jobs/PruneOldServerMetricSamples'
import Server from '../../app/Models/Server'
import ServerMetricSample from '../../app/Models/ServerMetricSample'

// See monitor-crud.test.ts's SEED comment — each file isolates fixtures.
// Servers have no FK to teams, so a bare team id is enough here.
const SEED = 90084

/**
 * Cover for PruneOldServerMetricSamples, the retention sweep for
 * server_metric_samples. One row per host per minute makes that the
 * highest-volume table after check_results, and — like check_results before
 * PruneOldCheckResults existed — nothing else ever deletes from it.
 *
 * Needs the 0000000281/0000000282 migrations applied to the suite's
 * database; tests/feature/server-migrations.test.ts asserts the files
 * themselves against a throwaway file.
 *
 * The job reads SERVER_METRIC_SAMPLE_RETENTION_DAYS once at module load
 * (same shape as PruneOldCheckResults), so the cases here pin the default
 * 90-day window rather than juggling the env around an import.
 */
describe('PruneOldServerMetricSamples', () => {
  const DAY = 24 * 60 * 60 * 1000
  const serverIds: number[] = []

  function ago(days: number): string {
    return new Date(Date.now() - days * DAY).toISOString()
  }

  async function makeServer(name: string): Promise<number> {
    const server = await Server.create({
      teamId: SEED,
      name: `${name}-${SEED}`,
      metricsToken: `prune-${SEED}-${name}-${Math.floor(performance.now() * 1000)}`,
    })
    const id = Number((server as any).id)
    serverIds.push(id)
    return id
  }

  async function addSample(serverId: number, sampledAt: string, host = 'default'): Promise<void> {
    await ServerMetricSample.create({
      serverId,
      host,
      cpuPercent: 12.5,
      ramPercent: 40,
      ramUsedMb: 6400,
      ramTotalMb: 16000,
      breaches: '[]',
      sampledAt,
    })
  }

  async function sampledAtsFor(serverId: number): Promise<string[]> {
    const rows = await db.selectFrom('server_metric_samples')
      .where('server_id', '=', serverId)
      .select(['sampled_at'])
      .execute() as Array<{ sampled_at: string }>
    return rows.map(r => r.sampled_at).sort()
  }

  beforeAll(async () => {
    await awaitConfig()
  })

  afterAll(async () => {
    for (const id of serverIds) {
      await db.deleteFrom('server_metric_samples').where('server_id', '=', id).execute()
      await db.deleteFrom('servers').where('id', '=', id).execute()
    }
  })

  test('deletes samples older than 90 days and keeps everything newer', async () => {
    const serverId = await makeServer('retention')
    const stale = ago(91)
    const edge = ago(89)
    const fresh = ago(0)
    await addSample(serverId, stale)
    await addSample(serverId, edge)
    await addSample(serverId, fresh)
    // A second host on the same box ages out the same way.
    await addSample(serverId, ago(120), 'ip-10-0-0-2')
    expect(await sampledAtsFor(serverId)).toHaveLength(4)

    await PruneOldServerMetricSamples.handle()

    expect(await sampledAtsFor(serverId)).toEqual([edge, fresh].sort())
  })

  test('leaves other servers and the server row itself alone', async () => {
    const quiet = await makeServer('untouched')
    const recent = ago(1)
    await addSample(quiet, recent)

    await PruneOldServerMetricSamples.handle()

    expect(await sampledAtsFor(quiet)).toEqual([recent])
    const row = await Server.find(quiet)
    expect(row).toBeTruthy()
    expect(String(row!.name)).toBe(`untouched-${SEED}`)
    // A pruned history must not make a box look like it never reported —
    // the job never writes the denormalised columns on servers.
    expect(String(row!.status)).toBe('unknown')
  })

  test('is a no-op on a server with no samples', async () => {
    const empty = await makeServer('empty')
    await PruneOldServerMetricSamples.handle()
    expect(await sampledAtsFor(empty)).toEqual([])
    expect(await Server.find(empty)).toBeTruthy()
  })
})
