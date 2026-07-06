import { describe, expect, test } from 'bun:test'
import { consensusStatus } from '../../config/regions'

/**
 * Consensus is what makes a second region *reduce* false alerts instead of
 * doubling them (stacksjs/status#1 Phase 11). The two properties that matter:
 *   1. a single-region install behaves exactly as it did before consensus, and
 *   2. with two regions, one region's blip cannot open an incident on its own.
 */
describe('consensusStatus', () => {
  test('single region reproduces "latest check wins" (down)', () => {
    expect(consensusStatus(['down'], 2)).toBe('down')
  })

  test('single region reproduces "latest check wins" (up)', () => {
    expect(consensusStatus(['up'], 2)).toBe('up')
  })

  test('two regions split down/up is SUPPRESSED to up', () => {
    expect(consensusStatus(['down', 'up'], 2)).toBe('up')
  })

  test('two regions both down confirms down', () => {
    expect(consensusStatus(['down', 'down'], 2)).toBe('down')
  })

  test('two regions down+degraded is degraded (not enough outright down)', () => {
    expect(consensusStatus(['down', 'degraded'], 2)).toBe('degraded')
  })

  test('two regions degraded+up stays up', () => {
    expect(consensusStatus(['degraded', 'up'], 2)).toBe('up')
  })

  test('three regions with a 2-region majority down confirms down', () => {
    expect(consensusStatus(['down', 'down', 'up'], 2)).toBe('down')
  })

  test('no votes is unknown (leave status untouched)', () => {
    expect(consensusStatus([], 2)).toBe('unknown')
  })

  test('a lone reporting region still alerts when the other is silent (threshold clamps to votes present)', () => {
    // Only one region reported (the other worker is down); required clamps to
    // 1, so a genuine outage is not masked by the missing region.
    expect(consensusStatus(['down'], 2)).toBe('down')
  })

  test('minRegionsToConfirm below 1 is floored to 1', () => {
    expect(consensusStatus(['down'], 0)).toBe('down')
  })
})
