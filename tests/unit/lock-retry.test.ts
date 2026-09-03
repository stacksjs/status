import { describe, expect, test } from 'bun:test'
import { isLockError, withLockRetry } from '../../app/Commands/MigrateServers'

/**
 * The retry the backfill wraps every write in. The live run died on
 * "database is locked" despite the framework's busy_timeout, so a locked
 * write must be retried with backoff, and anything else must surface at once.
 */
describe('withLockRetry', () => {
  const noSleep = { sleep: async () => {} }

  test('recognises the lock errors SQLite and the other dialects raise', () => {
    expect(isLockError(new Error('database is locked'))).toBe(true)
    expect(isLockError(new Error('SQLITE_BUSY: database is locked'))).toBe(true)
    expect(isLockError(new Error('Deadlock found when trying to get lock'))).toBe(true)
    expect(isLockError(new Error('no such table: servers'))).toBe(false)
    expect(isLockError(new Error('UNIQUE constraint failed: servers.metrics_token'))).toBe(false)
  })

  test('retries a locked write until it succeeds and returns its value', async () => {
    let calls = 0
    const value = await withLockRetry(async () => {
      calls++
      if (calls < 4)
        throw new Error('database is locked')
      return 'done'
    }, 'test', noSleep)
    expect(value).toBe('done')
    expect(calls).toBe(4)
  })

  test('rethrows a non-lock error immediately, without retrying', async () => {
    let calls = 0
    await expect(withLockRetry(async () => {
      calls++
      throw new Error('no such table: servers')
    }, 'test', noSleep)).rejects.toThrow(/no such table/)
    expect(calls).toBe(1)
  })

  test('gives up after the attempt budget with the last lock error', async () => {
    let calls = 0
    await expect(withLockRetry(async () => {
      calls++
      throw new Error('database is locked')
    }, 'test', { ...noSleep, attempts: 5 })).rejects.toThrow(/database is locked/)
    expect(calls).toBe(5)
  })

  test('backs off exponentially and caps the delay', async () => {
    const delays: number[] = []
    let calls = 0
    await withLockRetry(async () => {
      calls++
      if (calls < 8)
        throw new Error('database is locked')
    }, 'test', { sleep: async (ms) => { delays.push(ms) }, baseDelayMs: 100, maxDelayMs: 1000 })
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000])
  })
})
