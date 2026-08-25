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
