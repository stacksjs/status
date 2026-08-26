/**
 * Per-type notification-channel configuration: the field set each channel
 * type needs, and the builder that turns a submitted form into the config
 * JSON `SendNotification` reads back.
 *
 * This exists because the dashboard used to ask operators to hand-type the
 * config as raw JSON (`{"webhookUrl": "https://..."}`) into a textarea. That
 * put the key names in three places — the model's doc comment, the form's
 * help text, and SendNotification's switch — with nothing keeping them
 * honest. They had already drifted: the help text told you to give an ntfy
 * channel a `webhookUrl`, while `sendNtfy` reads `topic` (and an optional
 * `server`), so anyone who followed the on-screen instructions created a
 * channel that threw "ntfy channel is missing topic" on its first real
 * alert — at 3am, on the alert that was supposed to wake them.
 *
 * So `key` below is not documentation, it is the contract: it must name a
 * property SendNotification actually destructures for that type. The
 * settings form renders its inputs from this table and the create action
 * reads them back through the same table, so a field can't be added to one
 * without the other. tests/unit/channel-config-wiring.test.ts asserts every
 * key here appears in app/Jobs/SendNotification.ts.
 */

export type ChannelInput = 'text' | 'url' | 'email' | 'tel' | 'json'

export interface ChannelField {
  /** Form input name. Unique across all types, so one flat form can hold every type's fields. */
  name: string
  /** Property written into the channel's config JSON — must match what SendNotification reads. */
  key: string
  label: string
  input: ChannelInput
  required: boolean
  placeholder?: string
  /** Shown under the input. Says where to get the value, not what the field is. */
  help?: string
}

export interface ChannelType {
  value: string
  label: string
  /** One-line orientation shown when this type is selected. */
  setup: string
  fields: ChannelField[]
}

/**
 * Ordered for the type picker: the channels a team is most likely to want
 * first, paging providers after them, generic webhook last.
 */
export const CHANNEL_TYPES: ChannelType[] = [
  {
    value: 'email',
    label: 'Email',
    setup: 'Alerts are sent from your configured mail transport.',
    fields: [
      { name: 'cfg_email', key: 'email', label: 'Email address', input: 'email', required: true, placeholder: 'ops@example.com' },
    ],
  },
  {
    value: 'sms',
    label: 'SMS',
    setup: 'Alerts are sent through your configured SMS provider.',
    fields: [
      { name: 'cfg_phone', key: 'phone', label: 'Phone number', input: 'tel', required: true, placeholder: '+15551234567', help: 'Include the country code.' },
    ],
  },
  {
    value: 'slack',
    label: 'Slack',
    setup: 'Slack → your workspace → Apps → Incoming Webhooks → Add to Slack, pick the channel, then copy the webhook URL.',
    fields: [
      { name: 'cfg_slack_url', key: 'webhookUrl', label: 'Incoming webhook URL', input: 'url', required: true, placeholder: 'https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXX' },
    ],
  },
  {
    value: 'discord',
    label: 'Discord',
    setup: 'Discord → Server Settings → Integrations → Webhooks → New Webhook, pick the channel, then Copy Webhook URL.',
    fields: [
      { name: 'cfg_discord_url', key: 'webhookUrl', label: 'Webhook URL', input: 'url', required: true, placeholder: 'https://discord.com/api/webhooks/000000000/XXXXXXXX' },
    ],
  },
  {
    value: 'teams',
    label: 'Microsoft Teams',
    setup: 'Teams → the channel’s ⋯ menu → Connectors → Incoming Webhook → Configure, name it, then copy the URL.',
    fields: [
      { name: 'cfg_teams_url', key: 'webhookUrl', label: 'Incoming webhook URL', input: 'url', required: true, placeholder: 'https://outlook.office.com/webhook/...' },
    ],
  },
  {
    value: 'pagerduty',
    label: 'PagerDuty',
    setup: 'PagerDuty → Services → your service → Integrations → add an Events API v2 integration, then copy its Integration Key.',
    fields: [
      { name: 'cfg_routing_key', key: 'routingKey', label: 'Integration key', input: 'text', required: true, placeholder: 'R0XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', help: 'Events API v2 routing key — 32 characters.' },
    ],
  },
  {
    value: 'opsgenie',
    label: 'Opsgenie',
    setup: 'Opsgenie → Teams → your team → Integrations → add an API integration, then copy its API key.',
    fields: [
      { name: 'cfg_api_key', key: 'apiKey', label: 'API key', input: 'text', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
    ],
  },
  {
    value: 'pushover',
    label: 'Pushover',
    setup: 'Pushover → your dashboard for the user key, then Create an Application for the API token.',
    fields: [
      { name: 'cfg_user_key', key: 'userKey', label: 'User key', input: 'text', required: true, placeholder: 'uQiXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
      { name: 'cfg_api_token', key: 'apiToken', label: 'Application API token', input: 'text', required: true, placeholder: 'azGXXXXXXXXXXXXXXXXXXXXXXXXXXX' },
    ],
  },
  {
    value: 'ntfy',
    label: 'ntfy',
    setup: 'Pick any topic name and subscribe to it in the ntfy app. Anyone who knows a public topic can read it, so choose something unguessable.',
    fields: [
      { name: 'cfg_ntfy_topic', key: 'topic', label: 'Topic', input: 'text', required: true, placeholder: 'statushq-a8f3c1', help: 'The topic name only — not a full URL.' },
      { name: 'cfg_ntfy_server', key: 'server', label: 'Server', input: 'url', required: false, placeholder: 'https://ntfy.sh', help: 'Leave blank to use the public ntfy.sh server.' },
    ],
  },
  {
    value: 'webhook',
    label: 'Webhook',
    setup: 'Your endpoint receives a JSON POST with event, severity, subject, message, monitor and incident — see docs/operate/notifications.md for the payload.',
    fields: [
      { name: 'cfg_webhook_url', key: 'url', label: 'Endpoint URL', input: 'url', required: true, placeholder: 'https://example.com/hooks/statushq' },
      { name: 'cfg_webhook_headers', key: 'headers', label: 'Extra headers', input: 'json', required: false, placeholder: '{"Authorization": "Bearer ..."}', help: 'Optional JSON object, sent with every request. Leave blank for none.' },
    ],
  },
]

const BY_VALUE = new Map(CHANNEL_TYPES.map(t => [t.value, t]))

/** The display label for a channel type, falling back to the raw value. */
export function channelTypeLabel(type: string): string {
  return BY_VALUE.get(type)?.label ?? type
}

export type BuildConfigResult =
  | { ok: true, config: string }
  | { ok: false, error: 'unknown_type' | 'missing_config' | 'invalid_headers' }

/**
 * Assemble a channel's config JSON from submitted form values.
 *
 * `get` is the request's field accessor. Every type's fields share one form,
 * so this reads only the selected type's fields and ignores the rest —
 * whether the browser suppressed them (the form disables inputs for
 * non-selected types) or not.
 *
 * Optional fields are omitted entirely when blank rather than written as
 * empty strings, because SendNotification treats presence as intent:
 * `config.server || 'https://ntfy.sh'` survives an absent key but an empty
 * string would send the request to `/topic` on no host at all.
 */
export function buildChannelConfig(type: string, get: (name: string) => unknown): BuildConfigResult {
  const spec = BY_VALUE.get(type)
  if (!spec)
    return { ok: false, error: 'unknown_type' }

  const config: Record<string, unknown> = {}

  for (const field of spec.fields) {
    const value = String(get(field.name) ?? '').trim()

    if (!value) {
      if (field.required)
        return { ok: false, error: 'missing_config' }
      continue
    }

    if (field.input === 'json') {
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      }
      catch {
        return { ok: false, error: 'invalid_headers' }
      }
      // A JSON array or scalar would spread into `...config.headers` as
      // indices or throw, so require the object shape the consumer expects.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { ok: false, error: 'invalid_headers' }
      config[field.key] = parsed
      continue
    }

    config[field.key] = value
  }

  return { ok: true, config: JSON.stringify(config) }
}
