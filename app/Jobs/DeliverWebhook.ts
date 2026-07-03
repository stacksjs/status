import { createHmac } from 'node:crypto'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import WebhookSubscription from '../Models/WebhookSubscription'

/**
 * Delivers one signed webhook payload to one subscription. Own job (not
 * inline in the listener) so a slow/unreachable endpoint doesn't block
 * delivery to other subscribers, and gets its own retry/backoff.
 */
export default new Job({
  name: 'DeliverWebhook',
  description: 'Deliver a signed webhook payload to one subscription',
  queue: 'webhooks',
  tries: 3,
  backoff: 30,
  timeout: 15,

  async handle(payload: { subscriptionId: number, event: string, data: Record<string, unknown> }) {
    const subscription = await WebhookSubscription.find(payload.subscriptionId)
    if (!subscription || !subscription.enabled) return

    const body = JSON.stringify({ event: payload.event, data: payload.data, timestamp: new Date().toISOString() })
    const signature = createHmac('sha256', subscription.secret).update(body).digest('hex')

    try {
      const response = await fetch(subscription.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': payload.event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok)
        throw new Error(`Webhook endpoint responded ${response.status}`)
    }
    catch (error) {
      log.warn(`[job] DeliverWebhook: delivery to subscription ${subscription.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      throw error // let the queue's retry/backoff handle transient failures
    }
  },
})
