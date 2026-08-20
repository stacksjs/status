import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * The installer at public/install-agent.sh is the only collector this product
 * ships, so it IS the contract with /api/agent/{token}/metrics.
 *
 * It drifted from that contract once already: the endpoint accepted and
 * threshold-alerted `diskPercent` from the day metrics shipped, while the
 * collector sent CPU and RAM only — so a disk breach could only ever page
 * someone who had hand-written their own. These tests pin the collector to the
 * fields the action actually reads, and pin the dashboard to the installer so
 * the copy-paste command and the shipped script cannot drift apart.
 */

const ROOT = resolve(import.meta.dir, '../..')
const VIEW = readFileSync(`${ROOT}/resources/views/dashboard/monitors/[id].stx`, 'utf8')
const ACTION = readFileSync(`${ROOT}/app/Actions/Agents/ReceiveMetricsAction.ts`, 'utf8')
const INSTALLER = readFileSync(`${ROOT}/public/install-agent.sh`, 'utf8')

/** The collector heredoc the installer writes to /usr/local/bin/statushq-agent. */
function collector(): string {
  const match = INSTALLER.match(/<<'COLLECTOR'\n([\s\S]*?)\nCOLLECTOR\n/)
  expect(match).toBeTruthy()
  return match![1]
}

describe('agent collector', () => {
  test('posts every field the ingest endpoint requires', () => {
    const body = collector()
    for (const field of ['cpuPercent', 'ramPercent', 'ramUsedMb', 'ramTotalMb'])
      expect(body).toContain(field)
  })

  test('collects and posts disk usage', () => {
    const body = collector()
    expect(body).toContain('diskPercent')
    // Not just interpolated — actually measured on the host.
    expect(body).toContain('df -P')
  })

  test('every field the collector sends is one the action reads', () => {
    const sent = [...collector().matchAll(/\\"(\w+)\\":/g)].map(m => m[1])
    expect(sent.length).toBeGreaterThan(0)
    for (const field of sent)
      expect(ACTION).toContain(field)
  })

  test('identifies which machine the sample came from', () => {
    // Without it, four boxes cron-ing the same token are one anonymous series
    // and the page shows whichever reported last. The SDKs send `host`; the
    // installer is the third collector and must not be the odd one out.
    const body = collector()
    // The payload is built inside a double-quoted shell string, so the JSON
    // key is escaped as \"host\" -- matching on a bare "host" would pass on
    // the surrounding prose and fail on the line that matters.
    expect(body).toContain('\\"host\\":')
    expect(body).toContain('hostname')
  })

  test('posts to the agent ingest route with the host token', () => {
    const body = collector()
    expect(body).toContain('/api/agent/')
    expect(body).toContain('/metrics')
    expect(body).toContain('STATUSHQ_TOKEN')
  })

  test('fails loudly on a rejected push rather than exiting 0', () => {
    // Without -f, curl treats a 404 (bad token) or 422 (bad payload) as
    // success, so the timer records a clean run while nothing is ingested and
    // the monitor looks healthy until the missed-push window trips.
    expect(collector()).toMatch(/curl -fsS/)
  })

  test('is POSIX sh, not bash', () => {
    // cron runs /bin/sh — dash on Debian and Ubuntu. The snippet this replaced
    // used `read A B < <(free -m ...)`, which dash cannot parse, so pasting it
    // into a crontab died with a syntax error and the host silently never
    // reported. Keep process substitution and other bashisms out.
    const body = collector()
    expect(body).not.toContain('< <(')
    expect(body).not.toMatch(/^\s*(local|declare|source)\s/m)
    expect(body.split('\n')[0]).toBe('#!/bin/sh')
  })

  test('keeps the ingest token out of the world-readable collector', () => {
    // The collector lands in /usr/local/bin (0755); the token belongs in the
    // 0600 env file the installer writes separately.
    expect(collector()).not.toContain('--token')
    expect(INSTALLER).toContain('chmod 600 "$ENV_PATH"')
  })
})

describe('dashboard agent setup card', () => {
  test('hands the operator the installer, not a hand-rolled snippet', () => {
    expect(VIEW).toContain('/install-agent.sh')
    expect(VIEW).toContain('__agentInstall')
  })

  test('keeps the raw ingest call available as an escape hatch', () => {
    expect(VIEW).toContain('/api/agent/')
    expect(VIEW).toContain('cpuPercent')
  })

  test('builds the command on a bridge-skipped binding', () => {
    // metrics_token is a credential: it may be rendered into the owner's HTML
    // but must never reach stx's server->client data bridge. A `__` prefix is
    // what excludes it — see tests/unit/bridge-hygiene.test.ts.
    expect(VIEW).not.toMatch(/^(?!.*__agentInstall).*\{\{\s*monitor\.metrics_token\s*\}\}/m)
  })
})
