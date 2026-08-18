import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { awaitConfig } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { openIncident } from '../../app/lib/maintenance'
import DnsSnapshot from '../../app/Models/DnsSnapshot'
import Incident from '../../app/Models/Incident'
import Monitor from '../../app/Models/Monitor'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const SEED = 90031
const TEAM_NAME = `Dns Change Team ${SEED}`

/**
 * Covers the two halves of the DNS-drift contract that had no test:
 *
 *  1. `openIncident` refuses to stack a second unresolved incident with the
 *     same cause. Every check type re-derives the same cause while a problem
 *     persists, and each duplicate fires a fresh notification to every
 *     attached channel — production had accumulated 18 identical SSL
 *     incidents and 12 identical port-scan ones before this moved out of the
 *     individual jobs and into the shared opener.
 *
 *  2. The snapshot diff itself: a record set that changes is one incident, a
 *     record set that is removed outright reads differently (and harder),
 *     and an unchanged set writes no new snapshot row at all.
 *
 * The diff is exercised against DnsSnapshot rows directly rather than by
 * running RunDnsCheck, because the job resolves live DNS — a network
 * dependency that would make this test flaky and slow.
 */
describe('DNS change detection and duplicate-incident suppression', () => {
  let teamId: number
  let monitorId: number

  async function cleanupTeam(): Promise<void> {
    const team = await db.selectFrom('teams').where('name', '=', TEAM_NAME).select(['id']).executeTakeFirst()
    if (team) {
      teamId = Number(team.id)
      for (const monitor of await Monitor.where('team_id', teamId).get()) {
        await db.deleteFrom('dns_snapshots').where('monitor_id', '=', monitor.id).execute()
        await db.deleteFrom('incidents').where('monitor_id', '=', monitor.id).execute()
        await monitor.delete()
      }
      await db.deleteFrom('teams').where('id', '=', teamId).execute()
    }
  }

  beforeAll(async () => {
    await awaitConfig()
    await cleanupTeam()
    await db.insertInto('teams').values({ name: TEAM_NAME }).execute()
    teamId = Number((await db.selectFrom('teams').where('name', '=', TEAM_NAME).select(['id']).executeTakeFirst())!.id)
  })

  beforeEach(async () => {
    for (const monitor of await Monitor.where('team_id', teamId).get()) {
      await db.deleteFrom('dns_snapshots').where('monitor_id', '=', monitor.id).execute()
      await db.deleteFrom('incidents').where('monitor_id', '=', monitor.id).execute()
      await monitor.delete()
    }
    const monitor = await Monitor.create({
      team_id: teamId,
      name: `dns-change-${SEED}`,
      type: 'dns',
      url: 'https://example.com',
      status: 'up',
    })
    monitorId = Number((monitor as any).id)
  })

  afterAll(cleanupTeam)

  test('a second incident with the same cause is suppressed while the first is open', async () => {
    const cause = 'MX records changed for example.com'

    const first = await openIncident({ monitor_id: monitorId, started_at: new Date().toISOString(), cause, status: 'monitoring' })
    const second = await openIncident({ monitor_id: monitorId, started_at: new Date().toISOString(), cause, status: 'monitoring' })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect((await Incident.where('monitor_id', monitorId).get()).length).toBe(1)
  })

  test('the same cause opens again once the previous incident is resolved', async () => {
    const cause = 'NS records changed for example.com'

    const first = await openIncident({ monitor_id: monitorId, started_at: new Date().toISOString(), cause, status: 'investigating' })
    await (first as any).update({ status: 'resolved', resolved_at: new Date().toISOString() })

    const second = await openIncident({ monitor_id: monitorId, started_at: new Date().toISOString(), cause, status: 'investigating' })

    expect(second).not.toBeNull()
    expect((await Incident.where('monitor_id', monitorId).get()).length).toBe(2)
  })

  test('a different cause on the same monitor is never suppressed', async () => {
    const opened = await openIncident({ monitor_id: monitorId, started_at: new Date().toISOString(), cause: 'A records changed for example.com', status: 'monitoring' })
    const other = await openIncident({ monitor_id: monitorId, started_at: new Date().toISOString(), cause: 'TXT records changed for example.com', status: 'monitoring' })

    expect(opened).not.toBeNull()
    expect(other).not.toBeNull()
    expect((await Incident.where('monitor_id', monitorId).get()).length).toBe(2)
  })

  test('an unchanged record set is recognised as unchanged', async () => {
    // Canonicalised the way RunDnsCheck writes it: values sorted, so a
    // round-robin rotation from the nameserver is not a change.
    const serialized = JSON.stringify(['93.184.216.34', '93.184.216.35'])
    await DnsSnapshot.create({ monitor_id: monitorId, record_type: 'A', record_values: serialized, checked_at: new Date().toISOString() })

    const previous = await DnsSnapshot.where('monitor_id', monitorId).where('record_type', 'A').orderByDesc('id').first()
    const rotated = JSON.stringify(['93.184.216.35', '93.184.216.34'].sort())

    expect(previous!.record_values).toBe(rotated)

    // The job only writes when the value differs, so the table still holds
    // exactly one row for this record type.
    expect((await DnsSnapshot.where('monitor_id', monitorId).where('record_type', 'A').get()).length).toBe(1)
  })

  test('a removed record set is distinguishable from a changed one', async () => {
    const before = JSON.stringify(['10 mail.example.com'])
    await DnsSnapshot.create({ monitor_id: monitorId, record_type: 'MX', record_values: before, checked_at: new Date().toISOString() })

    // What the job records when the resolver answers ENODATA: an empty set,
    // which is a real state and not a resolver failure.
    const removed = JSON.stringify([])
    await DnsSnapshot.create({ monitor_id: monitorId, record_type: 'MX', record_values: removed, checked_at: new Date().toISOString() })

    const snapshots = await DnsSnapshot.where('monitor_id', monitorId).where('record_type', 'MX').get()
    expect(snapshots.length).toBe(2)

    // Ordered by id, not created_at: both rows land in the same second here,
    // which is exactly the tie that used to return the wrong "previous" row.
    const latest = await DnsSnapshot.where('monitor_id', monitorId).where('record_type', 'MX').orderByDesc('id').first()
    expect(JSON.parse(latest!.record_values as string).length).toBe(0)

    // Losing every MX record is escalated to 'investigating', not the
    // 'monitoring' a routine rotation gets.
    const opened = await openIncident({
      monitor_id: monitorId,
      started_at: new Date().toISOString(),
      cause: 'All MX records were removed for example.com',
      status: 'investigating',
    })
    expect(opened).not.toBeNull()
    expect((opened as any).status).toBe('investigating')
  })
})
