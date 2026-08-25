import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Every field a monitor form posts must be read by the action it posts to.
 *
 * `health_secret` and `health_max_age_seconds` were rendered by both forms
 * and read by neither action for as long as the health monitor type has
 * existed. Nothing failed: the field accepted input, the form saved, the
 * redirect said success, and the value came back empty on reload — so it
 * read as operator error rather than a bug. It cost a live monitoring setup
 * an afternoon.
 *
 * No existing test could catch it. The unit tests call buildMonitorConfig
 * directly and passed throughout, because that function was correct; the
 * feature tests call the actions with hand-written field bags, so they only
 * ever exercised the fields someone remembered to type. The gap was between
 * the two — a field that exists in the markup and nowhere else.
 *
 * This closes it by comparing the two lists as text. That is deliberately
 * cheap: it needs no browser and no server, and the failure it prevents is
 * silent data loss, which is the kind worth a crude guard.
 */
const ROOT = join(import.meta.dir, '../..')

/** `name="…"` on inputs/selects/textareas inside the given markup. */
function postedFields(markup: string): Set<string> {
  return new Set(
    (markup.match(/<(?:input|select|textarea)\b[^>]*\bname="([a-z_]+)"/gi) ?? [])
      .map(tag => /\bname="([a-z_]+)"/.exec(tag)![1]),
  )
}

/** Keys the action pulls off the request. */
function readFields(source: string): Set<string> {
  return new Set(
    (source.match(/request\.get\('([a-z_]+)'\)/g) ?? [])
      .map(call => /request\.get\('([a-z_]+)'\)/.exec(call)![1]),
  )
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/**
 * The monitor types an input at `at` is gated to, sorted, or null if nothing
 * gates it. Walks outward from the input: its own `.field` wrapper first,
 * then the nearest enclosing `<section>`, since either placement hides it.
 */
function gateFor(source: string, at: number): string[] | null {
  const before = source.slice(0, at)

  for (const opener of ['<div class="field"', '<section']) {
    const openedAt = before.lastIndexOf(opener)
    if (openedAt === -1)
      continue
    const tag = source.slice(openedAt, source.indexOf('>', openedAt) + 1)
    const declared = /data-types="([^"]*)"/.exec(tag)
    if (declared)
      return declared[1].split(' ').sort()
  }

  return null
}

describe('monitor forms are wired to their actions', () => {
  test('the new-monitor form posts nothing the create action ignores', () => {
    const view = read('resources/views/dashboard/monitors/new.stx')
    const action = read('app/Actions/Monitors/DashboardCreateMonitorAction.ts')

    const posted = postedFields(view)
    const handled = readFields(action)

    expect(posted.size).toBeGreaterThan(10)
    expect([...posted].filter(f => !handled.has(f)).sort()).toEqual([])
  })

  test('the edit-monitor form posts nothing the update action ignores', () => {
    const view = read('resources/views/dashboard/monitors/[id].stx')
    const action = read('app/Actions/Monitors/DashboardUpdateMonitorAction.ts')

    // The page carries several unrelated forms (assertions, notification
    // channels), so scope to the one that posts to the update endpoint.
    const form = /<form\b[^>]*action="[^"]*monitor-forms[^"]*update[^"]*"[^>]*>([\s\S]*?)<\/form>/i.exec(view)
    expect(form).not.toBeNull()

    const posted = postedFields(form![1])
    const handled = readFields(action)

    expect(posted.size).toBeGreaterThan(10)
    expect([...posted].filter(f => !handled.has(f)).sort()).toEqual([])
  })

  /**
   * A field visible on a type whose branch never reads it is worse than a
   * missing field: it accepts input, saves without complaint, and comes back
   * empty. The edit form rendered TCP port, Health path, Health endpoint
   * secret and Report freshness for all fourteen types, which is what made
   * the wiring bug above read as operator error for as long as it did.
   *
   * These assert the markup agrees with buildMonitorConfig about which type
   * owns which field. Kept as a table rather than derived from the source so
   * a change to either side has to be made deliberately in both.
   */
  describe('type-specific fields are gated to the types that read them', () => {
    const OWNERS: Array<[string, string]> = [
      ['port', 'tcp_port'],
      ['path', 'health'],
      ['health_secret', 'health'],
      ['health_max_age_seconds', 'health'],
      ['latency_threshold_ms', 'uptime tcp_port health ping'],
      ['ping_count', 'ping'],
      ['packet_loss_threshold_percent', 'ping'],
      ['origin_ip', 'dns_blocklist'],
      ['expected_ports', 'port_scan'],
      ['lighthouse_device', 'lighthouse'],
      ['full_scan', 'port_scan'],
      ['alert_on_fingerprint_change', 'ssl'],
      ['expected_interval_seconds', 'cron'],
      ['grace_seconds', 'cron'],
      ['cron_expression', 'cron'],
    ]

    for (const view of [
      'resources/views/dashboard/monitors/new.stx',
      'resources/views/dashboard/monitors/[id].stx',
    ]) {
      test(`${view.split('/').pop()} gates every type-specific field`, () => {
        const source = read(view)

        for (const [field, types] of OWNERS) {
          const at = source.indexOf(`name="${field}"`)
          expect(at, `${field} is missing from ${view}`).toBeGreaterThan(-1)

          // The gate sits either on the field's own wrapper or on an
          // enclosing container — new.stx puts the heartbeat fields in a
          // <section data-types="cron"> and leaves their .field divs bare,
          // which is equivalent and shouldn't be a failure here.
          expect(gateFor(source, at), `${field} has no data-types in ${view}`)
            .toEqual(types.split(' ').sort())
        }
      })
    }

    test('the edit form no longer gates the heartbeat fields on the current type', () => {
      // They used to sit behind `@if (monitor.type === 'cron')` INSIDE the
      // form, which made switching a monitor TO cron impossible from this
      // page: the fields that define the heartbeat only appeared once it
      // already was one. Scoped to the form on purpose — the same condition
      // still guards the heartbeat STATUS card elsewhere on the page, and
      // that one is correct: it renders live ping state that does not exist
      // for a non-cron monitor.
      const source = read('resources/views/dashboard/monitors/[id].stx')
      const form = /<form\b[^>]*action="[^"]*monitor-forms[^"]*update[^"]*"[^>]*>([\s\S]*?)<\/form>/i.exec(source)

      expect(form).not.toBeNull()
      expect(form![1]).not.toContain('@if (monitor.type')
      expect(form![1]).toContain('name="cron_expression"')
    })
  })

  test('both forms offer the health secret, and both actions read it', () => {
    // Named explicitly rather than left to the sweep above, so the specific
    // regression is legible in the failure output.
    for (const [view, action] of [
      ['resources/views/dashboard/monitors/new.stx', 'app/Actions/Monitors/DashboardCreateMonitorAction.ts'],
      ['resources/views/dashboard/monitors/[id].stx', 'app/Actions/Monitors/DashboardUpdateMonitorAction.ts'],
    ]) {
      expect(read(view)).toContain('name="health_secret"')
      expect(readFields(read(action)).has('health_secret')).toBe(true)
      expect(readFields(read(action)).has('health_max_age_seconds')).toBe(true)
    }
  })
})
