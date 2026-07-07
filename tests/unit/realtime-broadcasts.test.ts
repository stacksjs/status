import { describe, expect, test } from 'bun:test'
import { computeMonitorBroadcasts, type MonitorRow, type MonitorSnapshot } from '../../app/Commands/Realtime'

const uuids = new Map<number, string>([[5, 'uuid-team-5'], [7, 'uuid-team-7']])
const mon = (id: number, team_id: number, status: string, last_checked_at: string | null): MonitorRow => ({ id, team_id, status, last_checked_at })

describe('computeMonitorBroadcasts (realtime change detection)', () => {
  test('first poll primes silently — no broadcasts for first-seen monitors', () => {
    const last = new Map<number, MonitorSnapshot>()
    const out = computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1'), mon(2, 5, 'down', 't1')], uuids)
    expect(out).toHaveLength(0)
    expect(last.get(1)).toEqual({ status: 'up', lastChecked: 't1' })
    expect(last.get(2)).toEqual({ status: 'down', lastChecked: 't1' })
  })

  test('a status transition broadcasts once, on the team uuid channel, with the new lastCheckedAt', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'up', lastChecked: 't1' }]])
    const out = computeMonitorBroadcasts(last, [mon(1, 5, 'down', 't2')], uuids)
    expect(out).toEqual([{ channel: 'team.uuid-team-5.monitors', id: 1, status: 'down', lastCheckedAt: 't2' }])
  })

  test('a fresh check (last_checked_at change) broadcasts even when status is unchanged', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'up', lastChecked: 't1' }]])
    const out = computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't2')], uuids)
    expect(out).toEqual([{ channel: 'team.uuid-team-5.monitors', id: 1, status: 'up', lastCheckedAt: 't2' }])
  })

  test('a genuinely unchanged monitor (same status AND last_checked_at) does not broadcast', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'up', lastChecked: 't1' }]])
    expect(computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1')], uuids)).toHaveLength(0)
  })

  test('a monitor created after priming is recorded silently, then broadcasts on its next change', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'up', lastChecked: 't1' }]])
    expect(computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1'), mon(9, 7, 'up', 't1')], uuids)).toHaveLength(0)
    const out = computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1'), mon(9, 7, 'down', 't2')], uuids)
    expect(out).toEqual([{ channel: 'team.uuid-team-7.monitors', id: 9, status: 'down', lastCheckedAt: 't2' }])
  })

  test('a team without a uuid produces no broadcast (unguessable-channel guard)', () => {
    const last = new Map<number, MonitorSnapshot>([[3, { status: 'up', lastChecked: 't1' }]])
    expect(computeMonitorBroadcasts(last, [mon(3, 99, 'down', 't2')], uuids)).toHaveLength(0)
  })

  test('a disappeared monitor is dropped so a re-created id cannot inherit a stale snapshot', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'up', lastChecked: 't1' }], [2, { status: 'down', lastChecked: 't1' }]])
    computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1')], uuids) // monitor 2 gone
    expect(last.has(2)).toBe(false)
    expect(computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1'), mon(2, 5, 'up', 't1')], uuids)).toHaveLength(0)
  })

  test('multiple changes in one poll each broadcast on their own team channel', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'up', lastChecked: 't1' }], [9, { status: 'up', lastChecked: 't1' }]])
    const out = computeMonitorBroadcasts(last, [mon(1, 5, 'degraded', 't2'), mon(9, 7, 'up', 't2')], uuids)
    expect(out).toContainEqual({ channel: 'team.uuid-team-5.monitors', id: 1, status: 'degraded', lastCheckedAt: 't2' })
    expect(out).toContainEqual({ channel: 'team.uuid-team-7.monitors', id: 9, status: 'up', lastCheckedAt: 't2' })
    expect(out).toHaveLength(2)
  })

  test('null last_checked_at is handled and a transition to a real timestamp broadcasts', () => {
    const last = new Map<number, MonitorSnapshot>([[1, { status: 'unknown', lastChecked: null }]])
    const out = computeMonitorBroadcasts(last, [mon(1, 5, 'up', 't1')], uuids)
    expect(out).toEqual([{ channel: 'team.uuid-team-5.monitors', id: 1, status: 'up', lastCheckedAt: 't1' }])
  })
})
