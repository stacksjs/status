import { describe, expect, test } from 'bun:test'
import { buildChannelConfig, CHANNEL_TYPES, channelTypeLabel } from '../../app/lib/channelConfig'

/**
 * The channel config used to be typed by hand as raw JSON into a textarea,
 * with the key names living in three places that had already drifted: the
 * form's help text told operators an ntfy channel takes a `webhookUrl`,
 * while SendNotification's `sendNtfy` reads `topic` and `server`. Following
 * the on-screen instructions produced a channel that listed fine, tested
 * fine as far as the dashboard could tell, and threw on its first real
 * alert.
 *
 * The form now renders from CHANNEL_TYPES and the create action reads back
 * through it, so those two can't drift from each other. What they can still
 * drift from is the sender — nothing at runtime checks that `key` names a
 * property SendNotification destructures. That's what this file checks, by
 * reading the sender's source: it's a coarse check, but it fails loudly the
 * moment a key is renamed on one side only, which is the failure that
 * actually happened.
 */
const SENDER = await Bun.file(new URL('../../app/Jobs/SendNotification.ts', import.meta.url)).text()

const MODEL_TYPES = [
  'email',
  'sms',
  'slack',
  'discord',
  'teams',
  'pagerduty',
  'opsgenie',
  'pushover',
  'ntfy',
  'webhook',
]

describe('channel config spec', () => {
  test('every config key is one SendNotification actually reads', () => {
    for (const type of CHANNEL_TYPES) {
      for (const field of type.fields) {
        // `config.topic`, `config: { topic }`, or a destructured param — all
        // forms put the bare key adjacent to a word boundary in the source.
        const referenced = new RegExp(`\\b${field.key}\\b`).test(SENDER)
        expect(`${type.value}.${field.key} referenced in SendNotification: ${referenced}`)
          .toBe(`${type.value}.${field.key} referenced in SendNotification: true`)
      }
    }
  })

  test('the spec covers exactly the types the model allows', () => {
    expect(CHANNEL_TYPES.map(t => t.value).sort()).toEqual([...MODEL_TYPES].sort())
  })

  test('every type has at least one required field', () => {
    // A type with nothing required would accept an empty config and fail at
    // send time — the exact class of bug this table exists to close.
    for (const type of CHANNEL_TYPES)
      expect(`${type.value}: ${type.fields.some(f => f.required)}`).toBe(`${type.value}: true`)
  })

  test('form field names are unique across every type', () => {
    // All types render into one form, so a shared name would let one type's
    // value be submitted for another's field.
    const names = CHANNEL_TYPES.flatMap(t => t.fields.map(f => f.name))
    expect(new Set(names).size).toBe(names.length)
  })

  test('every type explains where to find its credentials', () => {
    for (const type of CHANNEL_TYPES)
      expect(`${type.value}: ${type.setup.length > 30}`).toBe(`${type.value}: true`)
  })
})

describe('buildChannelConfig', () => {
  /** The request accessor's shape: a flat lookup over the submitted form. */
  const from = (fields: Record<string, string>) => (name: string) => fields[name]

  test('writes the key the sender reads, not the field name', () => {
    const built = buildChannelConfig('slack', from({ cfg_slack_url: 'https://hooks.slack.com/services/T/B/x' }))
    expect(built.ok).toBe(true)
    expect(JSON.parse((built as { config: string }).config)).toEqual({ webhookUrl: 'https://hooks.slack.com/services/T/B/x' })
  })

  test('reads only the selected type\'s fields', () => {
    // Every type's inputs share one form. With JS the others are disabled, but
    // a no-JS submit posts all of them, and they must not leak into the config.
    const built = buildChannelConfig('email', from({
      cfg_email: 'ops@example.com',
      cfg_slack_url: 'https://hooks.slack.com/services/T/B/x',
      cfg_phone: '+15551234567',
    }))
    expect(JSON.parse((built as { config: string }).config)).toEqual({ email: 'ops@example.com' })
  })

  test('a missing required field is rejected rather than stored empty', () => {
    expect(buildChannelConfig('pagerduty', from({}))).toEqual({ ok: false, error: 'missing_config' })
    expect(buildChannelConfig('pushover', from({ cfg_user_key: 'u' }))).toEqual({ ok: false, error: 'missing_config' })
  })

  test('a blank optional field is omitted, not written as an empty string', () => {
    // sendNtfy falls back with `config.server || 'https://ntfy.sh'`, which an
    // absent key survives — but an empty string would send the request to a
    // host-less URL.
    const built = buildChannelConfig('ntfy', from({ cfg_ntfy_topic: 'statushq-a8f3c1', cfg_ntfy_server: '   ' }))
    expect(JSON.parse((built as { config: string }).config)).toEqual({ topic: 'statushq-a8f3c1' })
  })

  test('values are trimmed, so a pasted trailing space is not part of the URL', () => {
    const built = buildChannelConfig('webhook', from({ cfg_webhook_url: '  https://example.com/hook  ' }))
    expect(JSON.parse((built as { config: string }).config)).toEqual({ url: 'https://example.com/hook' })
  })

  test('webhook headers parse into an object', () => {
    const built = buildChannelConfig('webhook', from({
      cfg_webhook_url: 'https://example.com/hook',
      cfg_webhook_headers: '{"Authorization": "Bearer abc"}',
    }))
    expect(JSON.parse((built as { config: string }).config)).toEqual({
      url: 'https://example.com/hook',
      headers: { Authorization: 'Bearer abc' },
    })
  })

  test('non-object headers are rejected', () => {
    const url = 'https://example.com/hook'
    // `...config.headers` on an array spreads indices into the header map;
    // on a scalar it throws inside the job rather than at save time.
    expect(buildChannelConfig('webhook', from({ cfg_webhook_url: url, cfg_webhook_headers: '["a"]' })))
      .toEqual({ ok: false, error: 'invalid_headers' })
    expect(buildChannelConfig('webhook', from({ cfg_webhook_url: url, cfg_webhook_headers: '"a"' })))
      .toEqual({ ok: false, error: 'invalid_headers' })
    expect(buildChannelConfig('webhook', from({ cfg_webhook_url: url, cfg_webhook_headers: 'not json' })))
      .toEqual({ ok: false, error: 'invalid_headers' })
  })

  test('an unknown type is rejected', () => {
    expect(buildChannelConfig('carrier-pigeon', from({}))).toEqual({ ok: false, error: 'unknown_type' })
  })

  test('channelTypeLabel falls back to the raw type', () => {
    expect(channelTypeLabel('pagerduty')).toBe('PagerDuty')
    expect(channelTypeLabel('carrier-pigeon')).toBe('carrier-pigeon')
  })
})
