import { afterEach, describe, expect, test } from 'bun:test'
import { config } from '@stacksjs/config'
import { broadcastMonitorUpdate, resolveRedisBroadcastConfig } from '../../app/Realtime/broadcastMonitorUpdate'

// The realtime config's redis block uses `prefix`; ts-broadcasting expects
// `keyPrefix`, and gates purely on the object's presence (no `enabled`
// field). resolveRedisBroadcastConfig owns that translation + the enabled
// gate — a mismatch silently breaks the worker->broadcaster relay.
type RedisBlock = { enabled?: boolean, host?: string, port?: number, password?: string, prefix?: string }
function setRedis(block: RedisBlock | undefined) {
  const rt = config.realtime as { server?: { redis?: RedisBlock } }
  rt.server = rt.server || {}
  rt.server.redis = block as RedisBlock
}

describe('resolveRedisBroadcastConfig', () => {
  const original = (config.realtime as { server?: { redis?: RedisBlock } }).server?.redis
  afterEach(() => setRedis(original))

  test('returns null when the redis block is absent', () => {
    setRedis(undefined)
    expect(resolveRedisBroadcastConfig()).toBeNull()
  })

  test('returns null when redis is present but disabled', () => {
    setRedis({ enabled: false, host: 'r', port: 6379, prefix: 'stacks:realtime:' })
    expect(resolveRedisBroadcastConfig()).toBeNull()
  })

  test('maps prefix -> keyPrefix and carries host/port when enabled', () => {
    setRedis({ enabled: true, host: 'redis.internal', port: 6390, password: 's3cret', prefix: 'stacks:realtime:' })
    expect(resolveRedisBroadcastConfig()).toEqual({ host: 'redis.internal', port: 6390, password: 's3cret', keyPrefix: 'stacks:realtime:' })
  })

  test('omits an empty password (undefined, not "") and defaults keyPrefix', () => {
    setRedis({ enabled: true, host: 'r', port: 6379, password: '', prefix: '' })
    const cfg = resolveRedisBroadcastConfig()
    expect(cfg?.password).toBeUndefined()
    expect(cfg?.keyPrefix).toBe('broadcasting:')
  })

  test('broadcastMonitorUpdate is a no-op (resolves, no throw) when redis is disabled', async () => {
    setRedis({ enabled: false })
    await expect(broadcastMonitorUpdate(999999)).resolves.toBeUndefined()
  })
})
