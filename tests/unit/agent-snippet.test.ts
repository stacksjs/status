import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The agent-setup snippet on the monitor page is the only collector this
 * product ships, so it IS the contract with /api/agent/{token}/metrics.
 * It drifted from that contract once already: the endpoint accepted and
 * threshold-alerted `diskPercent` from the day metrics shipped, while the
 * snippet collected CPU and RAM only — so a disk breach could only ever
 * page someone who had hand-written their own collector. These tests pin
 * the snippet to the fields the action actually reads.
 */

const ROOT = resolve(import.meta.dir, '../..')
const VIEW = readFileSync(`${ROOT}/resources/views/dashboard/monitors/[id].stx`, 'utf8')
const ACTION = readFileSync(`${ROOT}/app/Actions/Agents/ReceiveMetricsAction.ts`, 'utf8')

/** The `<pre class="code-block">` holding the cron snippet. */
function snippet(): string {
  const match = VIEW.match(/<pre class="code-block">([\s\S]*?)<\/pre>/)
  expect(match).toBeTruthy()
  return match![1]
}

describe('agent setup snippet', () => {
  test('posts every field the ingest endpoint requires', () => {
    const body = snippet()
    for (const field of ['cpuPercent', 'ramPercent', 'ramUsedMb', 'ramTotalMb'])
      expect(body).toContain(field)
  })

  test('collects and posts disk usage', () => {
    const body = snippet()
    expect(body).toContain('diskPercent')
    // Not just interpolated — actually measured on the host.
    expect(body).toContain('df')
  })

  test('every field the snippet sends is one the action reads', () => {
    const sent = [...snippet().matchAll(/\\"(\w+)\\":/g)].map(m => m[1])
    expect(sent.length).toBeGreaterThan(0)
    for (const field of sent)
      expect(ACTION).toContain(field)
  })

  test('identifies which machine the sample came from', () => {
    // Without it, four boxes cron-ing the same token are one anonymous series
    // and the page shows whichever reported last. The SDKs send `host`; the
    // snippet is the third collector and must not be the odd one out.
    const body = snippet()
    expect(body).toContain('host')
    expect(body).toContain('hostname')
  })

  test('posts to the agent ingest route with the monitor token', () => {
    const body = snippet()
    expect(body).toContain('/api/agent/')
    expect(body).toContain('/metrics')
    expect(body).toContain('metrics_token')
  })
})
