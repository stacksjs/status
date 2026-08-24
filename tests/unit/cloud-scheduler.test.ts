import { describe, expect, test } from 'bun:test'
import { tsCloud } from '../../config/cloud'

/**
 * Production ran TWO schedulers for weeks.
 *
 * buddy's deploy (`applyScheduledWork`) attaches a scheduler to the
 * migration-owning app site automatically when NO site declares a
 * `scheduler` property and app/Scheduler.ts declares scheduled work. This
 * app does run the scheduler — as the dedicated `scheduler` SITE — but that
 * is a site *named* scheduler, not a `scheduler:` property, so the
 * auto-detection could not see it and added a second one onto `main` (the
 * migration owner).
 *
 * The result: statushq-main-scheduler and statushq-scheduler both firing
 * every job about 11ms apart. Every check ran twice, and because
 * DispatchDueChecks and EvaluateMonitorConsensus ran concurrently,
 * openIncident()'s read-then-write duplicate guard could be raced — which is
 * where the pairs of identical incidents opened milliseconds apart came
 * from.
 *
 * These assertions exist because the fix is one easily-deleted line whose
 * absence is invisible until you read systemd on the box.
 */
describe('cloud config: exactly one scheduler', () => {
  const sites = tsCloud.sites as Record<string, any>

  test('a dedicated scheduler site runs app/Scheduler.ts', () => {
    expect(sites.scheduler).toBeTruthy()
    expect(String(sites.scheduler.start)).toContain('schedule:run')
  })

  test('main pins scheduler:false, which is what suppresses the auto-attached second one', () => {
    // Must be exactly `false`, not merely absent: buddy's guard is
    // `site?.scheduler !== undefined`, so leaving it off re-enables the
    // auto-attach.
    expect(sites.main.scheduler).toBe(false)
  })

  test('at least one site declares the property, so buddy never auto-attaches', () => {
    const declares = Object.values(sites).some(site => site?.scheduler !== undefined)
    expect(declares).toBe(true)
  })

  test('no site would make ts-cloud create a scheduler unit', () => {
    // ts-cloud: `scheduler === true || (typeof scheduler === 'object' && scheduler !== null)`
    const createsUnit = (s: unknown) => s === true || (typeof s === 'object' && s !== null)
    const offenders = Object.entries(sites).filter(([, site]) => createsUnit(site?.scheduler)).map(([name]) => name)
    expect(offenders).toEqual([])
  })

  test('only one site drives the schedule at all', () => {
    const drivers = Object.entries(sites)
      .filter(([, site]) => typeof site?.start === 'string' && site.start.includes('schedule:run'))
      .map(([name]) => name)
    expect(drivers).toEqual(['scheduler'])
  })
})
