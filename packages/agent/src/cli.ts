#!/usr/bin/env bun
import process from 'node:process'
import { collect } from './metrics'
import { metricsEndpoint, startReporter } from './reporter'

/**
 * `statushq-agent` — the no-code path.
 *
 * A Stacks app can import the library and push from its own scheduler, but a
 * plain box with cron should not have to write a sampler loop to report CPU.
 * This is the equivalent of what the Laravel package gets from its service
 * provider: install, set two variables, done.
 */

const USAGE = `statushq-agent — report host metrics to StatusHQ

Usage:
  statushq-agent report [options]     Take one sample and send it
  statushq-agent watch  [options]     Sample and send on an interval

Options:
  --url <url>        StatusHQ base URL      (env STATUSHQ_URL, default https://statushq.org)
  --token <token>    Metrics monitor token  (env STATUSHQ_TOKEN)
  --mount <path>     Filesystem to measure  (default /)
  --host <name>      Overrides the hostname reported with each sample
  --interval <secs>  watch only             (default 60)
  --dry              Print the sample instead of sending it
  --help

The token is on the monitor's Agent setup card. It identifies the monitor, so
treat it the way you would an API key.

Cron:
  * * * * * statushq-agent report --token $STATUSHQ_TOKEN
`

interface Flags { [key: string]: string | boolean }

export function parseArgs(argv: string[]): { command: string, flags: Flags } {
  const [command = 'report', ...rest] = argv
  const flags: Flags = {}

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (!arg.startsWith('--'))
      continue

    const key = arg.slice(2)
    const next = rest[i + 1]
    // A flag followed by another flag (or nothing) is a boolean, so `--dry`
    // does not silently swallow the argument after it.
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true
    }
    else {
      flags[key] = next
      i++
    }
  }

  return { command, flags }
}

function stringFlag(flags: Flags, key: string, fallback = ''): string {
  const value = flags[key]
  return typeof value === 'string' ? value : fallback
}

export async function run(argv: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  const { command, flags } = parseArgs(argv)

  if (flags.help || command === 'help') {
    console.log(USAGE)
    return 0
  }

  const url = stringFlag(flags, 'url', env.STATUSHQ_URL ?? 'https://statushq.org')
  const token = stringFlag(flags, 'token', env.STATUSHQ_TOKEN ?? '')
  const mount = stringFlag(flags, 'mount', '/')
  const host = stringFlag(flags, 'host') || undefined

  if (command !== 'report' && command !== 'watch') {
    console.error(`Unknown command "${command}".\n\n${USAGE}`)
    return 2
  }

  if (!flags.dry && token === '') {
    console.error('No token. Pass --token or set STATUSHQ_TOKEN — find it on the monitor\'s Agent setup card.')
    return 2
  }

  if (command === 'watch') {
    const seconds = Number(stringFlag(flags, 'interval', '60'))
    const reporter = startReporter({
      url,
      token,
      host,
      mount,
      intervalMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000,
    })

    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => { reporter.stop(); process.exit(0) })

    // Resolves only on signal: watch is a foreground process by design, so a
    // supervisor (systemd, pm2, a container) owns its lifecycle.
    return await new Promise<number>(() => {})
  }

  // One-shot: both CPU readings are taken here, a second apart. Fine for cron,
  // wrong inside a server — that is what startReporter is for.
  const metrics = await collect({ mount })
  const payload = { ...metrics, ...(host === undefined ? {} : { host }) }

  if (flags.dry) {
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  const response = await fetch(metricsEndpoint(url, token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    console.error(`Ingest responded ${response.status}: ${await response.text()}`)
    return 1
  }

  return 0
}

if (import.meta.main)
  process.exit(await run(process.argv.slice(2)))
