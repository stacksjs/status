import { describe, expect, test } from 'bun:test'
import { computeMonitorBroadcasts } from '../../app/Commands/Realtime'

const uuids = new Map<number, string>([[5, 'uuid-team-5'], [7, 'uuid-team-7']])

describe('computeMonitorBroadcasts (realtime transition detection)', () => {
  test('first poll primes silently — no broadcasts for first-seen monitors', () => {
    const last = new Map<number, string>()
    const out = computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'up' }, { id: 2, team_id: 5, status: 'down' }], uuids)
    expect(out).toHaveLength(0)
    expect(last.get(1)).toBe('up')
    expect(last.get(2)).toBe('down')
  })

  test('a status transition of a tracked monitor broadcasts once, on the team uuid channel', () => {
    const last = new Map<number, string>([[1, 'up']])
    const out = computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'down' }], uuids)
    expect(out).toEqual([{ channel: 'team.uuid-team-5.monitors', id: 1, status: 'down' }])
    expect(last.get(1)).toBe('down')
  })

  test('unchanged status does not broadcast', () => {
    const last = new Map<number, string>([[1, 'up']])
    expect(computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'up' }], uuids)).toHaveLength(0)
  })

  test('a monitor created after priming is recorded silently, then broadcasts on its next transition', () => {
    const last = new Map<number, string>([[1, 'up']])
    // Monitor 9 appears for the first time — recorded, not broadcast.
    expect(computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'up' }, { id: 9, team_id: 7, status: 'up' }], uuids)).toHaveLength(0)
    expect(last.get(9)).toBe('up')
    // Now it transitions — broadcast.
    const out = computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'up' }, { id: 9, team_id: 7, status: 'down' }], uuids)
    expect(out).toEqual([{ channel: 'team.uuid-team-7.monitors', id: 9, status: 'down' }])
  })

  test('a team without a uuid produces no broadcast (unguessable-channel guard)', () => {
    const last = new Map<number, string>([[3, 'up']])
    // team 99 has no uuid mapping
    expect(computeMonitorBroadcasts(last, [{ id: 3, team_id: 99, status: 'down' }], uuids)).toHaveLength(0)
  })

  test('a disappeared monitor is dropped so a re-created id cannot inherit a stale status', () => {
    const last = new Map<number, string>([[1, 'up'], [2, 'down']])
    computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'up' }], uuids) // monitor 2 gone
    expect(last.has(2)).toBe(false)
    // A new monitor re-using id 2 is treated as first-seen (no spurious broadcast).
    expect(computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'up' }, { id: 2, team_id: 5, status: 'up' }], uuids)).toHaveLength(0)
  })

  test('multiple transitions in one poll each broadcast on their own team channel', () => {
    const last = new Map<number, string>([[1, 'up'], [9, 'up']])
    const out = computeMonitorBroadcasts(last, [{ id: 1, team_id: 5, status: 'degraded' }, { id: 9, team_id: 7, status: 'down' }], uuids)
    expect(out).toContainEqual({ channel: 'team.uuid-team-5.monitors', id: 1, status: 'degraded' })
    expect(out).toContainEqual({ channel: 'team.uuid-team-7.monitors', id: 9, status: 'down' })
    expect(out).toHaveLength(2)
  })
})
