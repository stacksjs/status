import { mail } from '@stacksjs/email'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { expandWindowIntervals } from '../lib/maintenance'
import MaintenanceWindow from '../Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../Models/MaintenanceWindowMonitor'
import StatusPage from '../Models/StatusPage'
import StatusPageMonitor from '../Models/StatusPageMonitor'
import StatusPageSubscriber from '../Models/StatusPageSubscriber'

/**
 * Emails a status page's subscribers ahead of an upcoming maintenance window
 * (docs/operate/maintenance.md: "subscribers ... can be notified when a
 * maintenance window is coming"). Runs on a schedule (see app/Scheduler.ts)
 * and announces each occurrence once, when it enters the lead window.
 *
 * Recurrence-aware: a recurring window announces every occurrence (the next
 * occurrence's start ISO is stored in subscribers_notified_for, so a fresh
 * occurrence a week later announces again). Same fan-out / dedup shape as
 * NotifyStatusReportSubscribers - a page showing several attached monitors
 * still emails its subscribers once.
 */

const LEAD_MS = 24 * 60 * 60 * 1000

export default new Job({
  name: 'NotifyUpcomingMaintenance',
  description: 'Email status page subscribers ahead of an upcoming maintenance window',
  queue: 'notifications',
  tries: 2,
  backoff: 30,
  timeout: 60,

  async handle() {
    const now = Date.now()
    const windows = (await MaintenanceWindow.all()).filter((w: any) => w.status !== 'cancelled')
    let emailed = 0

    for (const window of windows) {
      // The next occurrence that STARTS within the lead window.
      const next = expandWindowIntervals(window, now, now + LEAD_MS)
        .filter(iv => iv.startMs >= now)
        .sort((a, b) => a.startMs - b.startMs)[0]
      if (!next)
        continue

      const occIso = new Date(next.startMs).toISOString()
      if (window.subscribers_notified_for === occIso)
        continue // this occurrence was already announced

      // Resolve the status pages that show any monitor attached to this window,
      // deduped so a page with several attached monitors is emailed once.
      const links = await MaintenanceWindowMonitor.where('maintenance_window_id', window.id).get()
      const pageIds = new Set<number>()
      for (const link of links) {
        const attachments = await StatusPageMonitor.where('monitor_id', link.monitor_id).get()
        for (const attachment of attachments)
          pageIds.add(attachment.status_page_id)
      }

      const endIso = new Date(next.endMs).toISOString()
      const detail = window.description ? `\n\n${window.description}` : ''
      const message = `Scheduled maintenance "${window.title}" is planned from ${new Date(occIso).toUTCString()} to ${new Date(endIso).toUTCString()}.${detail}`

      for (const pageId of pageIds) {
        const statusPage = await StatusPage.find(pageId)
        if (!statusPage)
          continue

        const subscribers = await StatusPageSubscriber.where('status_page_id', statusPage.id).get()
        for (const subscriber of subscribers) {
          // mail.send never throws on transport failure (drivers resolve
          // { success: false }); inspect the result rather than let a failed
          // send count as delivered. Not rethrown for a queue retry - a retry
          // would re-email everyone who already received this notice.
          const result = await mail.send({
            to: subscriber.email,
            subject: `Upcoming maintenance: ${window.title}`,
            text: `${message}\n\nUnsubscribe: /status/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}`,
            html: `<p>${message}</p><p><a href="/status/${statusPage.slug}/unsubscribe/${subscriber.unsubscribe_token}">Unsubscribe</a></p>`,
          })

          if (result.success)
            emailed++
          else
            log.warn(`[job] NotifyUpcomingMaintenance: failed to email ${subscriber.email}: ${result.message}`)
        }
      }

      // Stamp the occurrence as announced even when there were no subscribers,
      // so the scan doesn't re-evaluate this window every tick. A subscriber
      // who signs up inside the lead window still sees the "under maintenance"
      // state on the status page; they just miss the advance email for this
      // one occurrence.
      await window.update({ subscribers_notified_for: occIso })
    }

    if (emailed > 0)
      log.debug(`[job] NotifyUpcomingMaintenance: emailed ${emailed} subscriber(s)`)
  },
})
