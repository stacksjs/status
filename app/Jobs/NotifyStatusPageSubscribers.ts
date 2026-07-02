import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import StatusPage from '../Models/StatusPage'
import StatusPageMonitor from '../Models/StatusPageMonitor'
import StatusPageSubscriber from '../Models/StatusPageSubscriber'

/**
 * Emails every subscriber of every status page that shows the affected
 * monitor. A monitor can appear on more than one status page (an internal
 * ops page and a customer-facing one, say), so this fans out per page —
 * each page's subscribers only hear about it once, not once per monitor
 * the incident might touch.
 */
export default new Job({
  name: 'NotifyStatusPageSubscribers',
  description: 'Email status page subscribers about an incident',
  queue: 'notifications',
  tries: 2,
  backoff: 30,
  timeout: 60,

  async handle(payload: { monitorId: number, subject: string, message: string }) {
    const attachments = await StatusPageMonitor.where('monitor_id', payload.monitorId).get()
    if (attachments.length === 0) return

    let emailed = 0

    for (const attachment of attachments) {
      const statusPage = await StatusPage.find(attachment.status_page_id)
      if (!statusPage) continue

      const subscribers = await StatusPageSubscriber.where('status_page_id', statusPage.id).get()
      for (const subscriber of subscribers) {
        try {
          await mail.send({
            to: subscriber.email,
            subject: payload.subject,
            text: `${payload.message}\n\nUnsubscribe: /status/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}`,
            html: `<p>${payload.message}</p><p><a href="/status/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}">Unsubscribe</a></p>`,
          })
          emailed++
        }
        catch (error) {
          log.warn(`[job] NotifyStatusPageSubscribers: failed to email ${subscriber.email}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    if (emailed > 0)
      log.debug(`[job] NotifyStatusPageSubscribers: emailed ${emailed} subscriber(s)`)
  },
})
