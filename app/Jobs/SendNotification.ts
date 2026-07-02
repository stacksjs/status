import { sendToDiscord, sendToSlack, sendToTeams } from '@stacksjs/chat'
import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { send as sendSms } from '@stacksjs/sms'
import NotificationChannel from '../Models/NotificationChannel'

interface NotificationPayload {
  channelId: number
  subject: string
  message: string
  /** 'critical' surfaces louder in channels that support it (Opsgenie P1, PagerDuty 'critical'). */
  severity: 'critical' | 'warning' | 'info'
}

async function sendPagerDuty(config: { routingKey?: string }, payload: NotificationPayload): Promise<void> {
  if (!config.routingKey) throw new Error('pagerduty channel is missing routingKey')
  const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      routing_key: config.routingKey,
      event_action: 'trigger',
      payload: {
        summary: payload.subject,
        source: 'status',
        severity: payload.severity === 'critical' ? 'critical' : payload.severity === 'warning' ? 'warning' : 'info',
        custom_details: { message: payload.message },
      },
    }),
  })
  if (!response.ok) throw new Error(`PagerDuty responded ${response.status}`)
}

async function sendOpsgenie(config: { apiKey?: string }, payload: NotificationPayload): Promise<void> {
  if (!config.apiKey) throw new Error('opsgenie channel is missing apiKey')
  const response = await fetch('https://api.opsgenie.com/v2/alerts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `GenieKey ${config.apiKey}`,
    },
    body: JSON.stringify({
      message: payload.subject,
      description: payload.message,
      priority: payload.severity === 'critical' ? 'P1' : payload.severity === 'warning' ? 'P3' : 'P5',
    }),
  })
  if (!response.ok) throw new Error(`Opsgenie responded ${response.status}`)
}

async function sendPushover(config: { userKey?: string, apiToken?: string }, payload: NotificationPayload): Promise<void> {
  if (!config.userKey || !config.apiToken) throw new Error('pushover channel is missing userKey/apiToken')
  const response = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      token: config.apiToken,
      user: config.userKey,
      title: payload.subject,
      message: payload.message,
      priority: payload.severity === 'critical' ? '1' : '0',
    }),
  })
  if (!response.ok) throw new Error(`Pushover responded ${response.status}`)
}

async function sendNtfy(config: { server?: string, topic?: string }, payload: NotificationPayload): Promise<void> {
  if (!config.topic) throw new Error('ntfy channel is missing topic')
  const server = config.server || 'https://ntfy.sh'
  const response = await fetch(`${server}/${config.topic}`, {
    method: 'POST',
    headers: {
      'Title': payload.subject,
      'Priority': payload.severity === 'critical' ? 'urgent' : payload.severity === 'warning' ? 'high' : 'default',
    },
    body: payload.message,
  })
  if (!response.ok) throw new Error(`ntfy responded ${response.status}`)
}

async function sendWebhook(config: { url?: string, headers?: Record<string, string> }, payload: NotificationPayload): Promise<void> {
  if (!config.url) throw new Error('webhook channel is missing url')
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...config.headers },
    body: JSON.stringify({ subject: payload.subject, message: payload.message, severity: payload.severity }),
  })
  if (!response.ok) throw new Error(`Webhook responded ${response.status}`)
}

/**
 * Sends one notification to one channel. Dispatched once per attached
 * channel by the incident event listeners (app/Actions/Notifications/) —
 * kept as its own job (rather than inline in the listener) so a slow or
 * failing channel (a webhook endpoint timing out) doesn't block the
 * others, and so retries/backoff apply per-channel.
 */
export default new Job({
  name: 'SendNotification',
  description: 'Send a notification to one configured channel',
  queue: 'notifications',
  tries: 3,
  backoff: 30,
  timeout: 30,

  async handle(payload: NotificationPayload) {
    const channel = await NotificationChannel.find(payload.channelId)
    if (!channel || !channel.enabled) return

    let config: Record<string, any> = {}
    try {
      config = channel.config ? JSON.parse(channel.config) : {}
    }
    catch {
      log.warn(`[job] SendNotification: channel ${channel.id} has malformed config JSON`)
      return
    }

    try {
      switch (channel.type) {
        case 'email':
          if (!config.email) throw new Error('email channel is missing email address')
          await mail.send({ to: config.email, subject: payload.subject, text: payload.message, html: `<p>${payload.message}</p>` })
          break
        case 'sms':
          if (!config.phone) throw new Error('sms channel is missing phone number')
          await sendSms({ to: config.phone, body: `${payload.subject}: ${payload.message}` })
          break
        case 'slack':
          await sendToSlack(config.webhookUrl, `*${payload.subject}*\n${payload.message}`)
          break
        case 'discord':
          await sendToDiscord(config.webhookUrl, `**${payload.subject}**\n${payload.message}`)
          break
        case 'teams':
          await sendToTeams(config.webhookUrl, `${payload.subject}\n${payload.message}`)
          break
        case 'pagerduty':
          await sendPagerDuty(config, payload)
          break
        case 'opsgenie':
          await sendOpsgenie(config, payload)
          break
        case 'pushover':
          await sendPushover(config, payload)
          break
        case 'ntfy':
          await sendNtfy(config, payload)
          break
        case 'webhook':
          await sendWebhook(config, payload)
          break
        default:
          log.warn(`[job] SendNotification: unknown channel type '${channel.type}'`)
      }
    }
    catch (error) {
      log.warn(`[job] SendNotification: failed to send via ${channel.type} channel ${channel.id}: ${error instanceof Error ? error.message : String(error)}`)
      throw error // let the queue's retry/backoff handle transient failures
    }
  },
})
