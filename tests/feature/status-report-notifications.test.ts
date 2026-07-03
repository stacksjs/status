import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig, config } from '@stacksjs/config'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import { emitter } from '@stacksjs/events'
import SendStatusReportUpdateNotification from '../../app/Actions/Notifications/SendStatusReportUpdateNotification'
import CreateStatusReportUpdateAction from '../../app/Actions/StatusPages/CreateStatusReportUpdateAction'
import appEvents from '../../app/Events'
import Monitor from '../../app/Models/Monitor'
import StatusPage from '../../app/Models/StatusPage'
import StatusPageMonitor from '../../app/Models/StatusPageMonitor'
import StatusPageSubscriber from '../../app/Models/StatusPageSubscriber'
import StatusReport from '../../app/Models/StatusReport'
import StatusReportMonitor from '../../app/Models/StatusReportMonitor'
import StatusReportUpdate from '../../app/Models/StatusReportUpdate'

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

  // Pins the production trigger chain the other tests skip past: the
  // observe: ['create'] trait must emit exactly 'statusreportupdate:created'
  // with a PLAIN attribute payload (the ORM used to dispatch the raw
  // ModelInstance, whose column properties are undefined — the whole
  // feature silently no-oped), app/Events.ts must map that event to the
  // listener this file imports, and the real emitted payload must drive
  // the listener end to end. Listeners themselves are only registered by
  // the API server entrypoint, so the wildcard hookup is the one link a
  // test process cannot exercise.
  test('creating an update through the ORM emits the wired event whose payload drives the emails', async () => {
    const monitor = await makeMonitor('Report-notify chain')
    const covered = await makePageWithSubscriber('report-notify-chain', 'chain@example.com', [monitor.id])
    const report = await makeReportCovering([monitor.id])

    const received: Array<Record<string, unknown>> = []
    const handler = (event: Record<string, unknown>) => {
      received.push(event)
    }
    emitter.on('statusreportupdate:created', handler as any)

    try {
      const update = await StatusReportUpdate.create({
        status_report_id: report.id,
        message: 'Read-only window starts in ten minutes.',
        status: 'identified',
        posted_at: new Date().toISOString(),
      })
      cleanup.push(update)

      expect(received).toHaveLength(1)
      expect(received[0]!.status_report_id).toBe(report.id)
      expect(received[0]!.message).toBe('Read-only window starts in ten minutes.')

      // app/Events.ts wires this exact event name to the listener action
      // imported at the top of this file.
      expect(appEvents['statusreportupdate:created']).toContain('Notifications/SendStatusReportUpdateNotification')

      await SendStatusReportUpdateNotification.handle(received[0] as { status_report_id: number, message: string, status: string })

      const sent = CaptureEmailDriver.all()
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe('chain@example.com')
      expect(String(sent[0]!.text)).toContain('Read-only window starts in ten minutes.')
      expect(String(sent[0]!.text)).toContain(`/status/${covered.page.slug}/unsubscribe/`)
    }
    finally {
      emitter.off('statusreportupdate:created', handler as any)
    }
  })

  // The store-override action (POST /status-report-updates) exists because
  // the useApi-generated store handler inserts via raw db writes that fire
  // no model events — this pins that the override creates through the ORM
  // (so observe fires; asserted via a temporary emitter handler) and
  // validates its inputs.
  test('the store-override action creates via the ORM and rejects bad input', async () => {
    const report = await makeReportCovering([])

    const received: unknown[] = []
    const handler = (event: unknown) => {
      received.push(event)
    }
    emitter.on('statusreportupdate:created', handler as any)

    try {
      const request = { get: (key: string) => ({ status_report_id: String(report.id), message: 'Posted through the override.', status: 'monitoring' } as Record<string, string>)[key] }
      const response = await CreateStatusReportUpdateAction.handle(request as any)
      expect(response.status).toBe(201)

      const created = await response.json() as { id: number, message: string }
      const row = await StatusReportUpdate.find(created.id)
      expect(row).toBeTruthy()
      cleanup.push(row!)
      expect(received).toHaveLength(1)

      const missingMessage = { get: (key: string) => ({ status_report_id: String(report.id) } as Record<string, string>)[key] }
      expect((await CreateStatusReportUpdateAction.handle(missingMessage as any)).status).toBe(422)

      const unknownReport = { get: (key: string) => ({ status_report_id: '999999999', message: 'orphan' } as Record<string, string>)[key] }
      expect((await CreateStatusReportUpdateAction.handle(unknownReport as any)).status).toBe(404)
    }
    finally {
      emitter.off('statusreportupdate:created', handler as any)
    }
  })
})
