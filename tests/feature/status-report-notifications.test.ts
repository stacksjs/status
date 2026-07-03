import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig, config } from '@stacksjs/config'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import SendStatusReportUpdateNotification from '../../app/Actions/Notifications/SendStatusReportUpdateNotification'
import Monitor from '../../app/Models/Monitor'
import StatusPage from '../../app/Models/StatusPage'
import StatusPageMonitor from '../../app/Models/StatusPageMonitor'
import StatusPageSubscriber from '../../app/Models/StatusPageSubscriber'
import StatusReport from '../../app/Models/StatusReport'
import StatusReportMonitor from '../../app/Models/StatusReportMonitor'

// See monitor-crud.test.ts's TEAM_ID comment — each feature test file
// isolates its fixtures under its own team_id.
const TEAM_ID = 90006

describe('Status report subscriber notifications (stacksjs/status#1 Phase 12 follow-up)', () => {
  // Same capture-driver latch as team-invite-email.test.ts — see the
  // comment there for why it must run after awaitConfig() and is never
  // restored. The sync queue driver runs NotifyStatusReportSubscribers
  // inline, so the capture store fills synchronously and no SMTP socket
  // is opened.
  beforeAll(async () => {
    await awaitConfig()
    ;(config.email as { default: string }).default = 'capture'
  })

  const cleanup: { delete: () => Promise<unknown> }[] = []

  afterEach(async () => {
    CaptureEmailDriver.clear()
    for (const record of cleanup.splice(0).reverse())
      await record.delete()
  })

  async function makeMonitor(name: string) {
    const monitor = await Monitor.create({ team_id: TEAM_ID, name, url: 'https://example.com', type: 'uptime', status: 'up' })
    cleanup.push(monitor)
    return monitor
  }

  async function makePageWithSubscriber(slug: string, email: string, monitorIds: number[]) {
    const page = await StatusPage.create({ team_id: TEAM_ID, title: slug, slug, is_public: true })
    cleanup.push(page)

    for (const [index, monitorId] of monitorIds.entries()) {
      const pivot = await StatusPageMonitor.create({ status_page_id: page.id, monitor_id: monitorId, display_name: `m${index}`, display_order: index })
      cleanup.push(pivot)
    }

    const subscriber = await StatusPageSubscriber.create({
      status_page_id: page.id,
      email,
      unsubscribe_token: crypto.randomUUID().replace(/-/g, ''),
      confirmed_at: new Date().toISOString(),
    })
    cleanup.push(subscriber)

    return { page, subscriber }
  }

  async function makeReportCovering(monitorIds: number[]) {
    const report = await StatusReport.create({ team_id: TEAM_ID, title: 'Database migration this weekend', body: 'Planned work', status: 'monitoring', started_at: new Date().toISOString() })
    cleanup.push(report)

    for (const monitorId of monitorIds) {
      const pivot = await StatusReportMonitor.create({ status_report_id: report.id, monitor_id: monitorId })
      cleanup.push(pivot)
    }

    return report
  }

  test('posting an update emails covered pages once and spares unrelated pages', async () => {
    const monitorA = await makeMonitor('Report-notify A')
    const monitorB = await makeMonitor('Report-notify B')
    const monitorC = await makeMonitor('Report-notify C')

    // Both covered monitors sit on the same page — its subscriber must
    // still get exactly one email, not one per covered monitor.
    const covered = await makePageWithSubscriber('report-notify-covered', 'covered@example.com', [monitorA.id, monitorB.id])
    await makePageWithSubscriber('report-notify-unrelated', 'unrelated@example.com', [monitorC.id])

    const report = await makeReportCovering([monitorA.id, monitorB.id])

    await SendStatusReportUpdateNotification.handle({
      status_report_id: report.id,
      message: 'Migration is underway, expect brief read-only windows.',
      status: 'monitoring',
    })

    const sent = CaptureEmailDriver.all()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('covered@example.com')
    expect(sent[0]!.subject).toContain('Database migration this weekend')
    expect(String(sent[0]!.text)).toContain('Migration is underway')
    expect(String(sent[0]!.text)).toContain(`/status/${covered.page.slug}/unsubscribe/${covered.subscriber.unsubscribe_token}`)
  })

  test('a report covering no monitors notifies nobody', async () => {
    await makePageWithSubscriber('report-notify-idle', 'idle@example.com', [(await makeMonitor('Report-notify idle')).id])
    const report = await makeReportCovering([])

    await SendStatusReportUpdateNotification.handle({
      status_report_id: report.id,
      message: 'This update has no audience yet.',
      status: 'investigating',
    })

    expect(CaptureEmailDriver.all()).toHaveLength(0)
  })
})
