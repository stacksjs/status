import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import StatusPage from '../Models/StatusPage'
import StatusPageMonitor from '../Models/StatusPageMonitor'
import StatusPageSubscriber from '../Models/StatusPageSubscriber'
import StatusReportMonitor from '../Models/StatusReportMonitor'

/**
 * Emails every subscriber of every status page that shows a monitor the
 * status report covers (stacksjs/status#1 Phase 12 follow-up — the
 * "subscriber notification dispatch" gap on status reports). Same
 * fan-out shape as NotifyStatusPageSubscribers, except a report spans
 * MANY monitors, so pages are resolved across the whole
 * status_report_monitors pivot and deduped first — a page showing three
 * covered monitors still emails its subscribers once, not three times.
 */
export default new Job({
  name: 'NotifyStatusReportSubscribers',
  description: 'Email status page subscribers about a status report announcement',
  queue: 'notifications',
  tries: 2,
  backoff: 30,
  timeout: 60,

  async handle(payload: { statusReportId: number, subject: string, message: string }) {
    const covered = await StatusReportMonitor.where('status_report_id', payload.statusReportId).get()
    if (covered.length === 0) return

    const pageIds = new Set<number>()
    for (const pivot of covered) {
      const attachments = await StatusPageMonitor.where('monitor_id', pivot.monitor_id).get()
      for (const attachment of attachments)
        pageIds.add(attachment.status_page_id)
    }

    let emailed = 0

    for (const pageId of pageIds) {
      const statusPage = await StatusPage.find(pageId)
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
          log.warn(`[job] NotifyStatusReportSubscribers: failed to email ${subscriber.email}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    if (emailed > 0)
      log.debug(`[job] NotifyStatusReportSubscribers: emailed ${emailed} subscriber(s)`)
  },
})
