import { describe, expect, test } from 'bun:test'
import { parseArgs, run } from '../../packages/agent/src/cli'

/**
 * The CLI is the no-code path — a box with cron and no application code.
 * Its contract is small enough to pin entirely.
 */

describe('parseArgs', () => {
  test('a value flag takes the next argument', () => {
    const { command, flags } = parseArgs(['report', '--token', 'abc', '--url', 'https://example.test'])

    expect(command).toBe('report')
    expect(flags.token).toBe('abc')
    expect(flags.url).toBe('https://example.test')
  })

  test('a boolean flag does not swallow the flag after it', () => {
    // `--dry --token abc` must not read "--token" as the value of --dry and
    // then silently report no token.
    const { flags } = parseArgs(['report', '--dry', '--token', 'abc'])

    expect(flags.dry).toBe(true)
    expect(flags.token).toBe('abc')
  })

  test('the command defaults to report', () => {
    expect(parseArgs([]).command).toBe('report')
  })
})

describe('run', () => {
  test('a dry run prints a sample and sends nothing', async () => {
    const printed: string[] = []
    const log = console.log
    console.log = (message: string) => { printed.push(message) }

    try {
      expect(await run(['report', '--dry', '--host', 'web-01'], {})).toBe(0)
    }
    finally {
      console.log = log
    }

    const payload = JSON.parse(printed.join('\n'))
    expect(payload.host).toBe('web-01')
    expect(typeof payload.ramTotalMb).toBe('number')
  })

  test('a missing token is an error that says where to find one', async () => {
    const errors: string[] = []
    const error = console.error
    console.error = (message: string) => { errors.push(message) }

    try {
      expect(await run(['report'], {})).toBe(2)
    }
    finally {
      console.error = error
    }

    expect(errors.join('\n')).toContain('Agent setup card')
  })

  test('the token can come from the environment', async () => {
    const requests: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string) => {
      requests.push(String(input))
      return new Response('{"success":true}', { status: 200 })
    }) as unknown as typeof fetch

    try {
      expect(await run(['report'], { STATUSHQ_TOKEN: 'env-token', STATUSHQ_URL: 'https://statushq.test' })).toBe(0)
    }
    finally {
      globalThis.fetch = originalFetch
    }

    expect(requests).toHaveLength(1)
    expect(requests[0]).toBe('https://statushq.test/api/agent/env-token/metrics')
  })

  test('an unknown command is refused rather than treated as report', async () => {
    const error = console.error
    console.error = () => {}

    try {
      expect(await run(['destroy', '--token', 'abc'], {})).toBe(2)
    }
    finally {
      console.error = error
    }
  })
})
