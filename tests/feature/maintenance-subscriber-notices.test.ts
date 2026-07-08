import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig, config } from '@stacksjs/config'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import NotifyUpcomingMaintenance from '../../app/Jobs/NotifyUpcomingMaintenance'
import MaintenanceWindow from '../../app/Models/MaintenanceWindow'
import MaintenanceWindowMonitor from '../../app/Models/MaintenanceWindowMonitor'
import Monitor from '../../app/Models/Monitor'
import StatusPage from '../../app/Models/StatusPage'
import StatusPageMonitor from '../../app/Models/StatusPageMonitor'
import StatusPageSubscriber from '../../app/Models/StatusPageSubscriber'

// See monitor-crud.test.ts's TEAM_ID comment — each file isolates fixtures.
const TEAM_ID = 90019

describe('Upcoming-maintenance subscriber notices (stacksjs/status#1)', () => {
  // Same capture-driver latch as status-report-notifications.test.ts — set
  // after awaitConfig(), never restored; the sync queue runs mail.send inline
  // so the capture store fills synchronously with no SMTP socket.
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

  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()
  const HOUR = 3600_000

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

  async function makeWindow(opts: Record<string, unknown>, monitorIds: number[]) {
    const win = await MaintenanceWindow.create({
      team_id: TEAM_ID,
      title: 'Database upgrade',
      description: 'Expect ~10 min of downtime',
      starts_at: iso(2 * HOUR),
      ends_at: iso(2 * HOUR + 30 * 60_000),
      status: 'scheduled',
      ...opts,
    })
    cleanup.push(win)
    for (const monitorId of monitorIds) {
      const link = await MaintenanceWindowMonitor.create({ maintenance_window_id: win.id, monitor_id: monitorId })
      cleanup.push(link)
    }
    return win
  }

  test('a window within the lead window emails covered subscribers once, and does not re-send', async () => {
    const monitor = await makeMonitor('notice A')
    const { subscriber } = await makePageWithSubscriber('notice-covered', 'covered@example.com', [monitor.id])
    const win = await makeWindow({}, [monitor.id])

    await NotifyUpcomingMaintenance.handle()
    let sent = CaptureEmailDriver.all()
    expect(sent.length).toBe(1)
    expect(sent[0]!.to).toBe(subscriber.email)
    expect(sent[0]!.subject).toContain('Upcoming maintenance')
    expect(sent[0]!.subject).toContain('Database upgrade')

    // The occurrence is stamped, so a second tick sends nothing more.
    const stamped = await MaintenanceWindow.find(win.id)
    expect(stamped!.subscribers_notified_for).toBeTruthy()

    await NotifyUpcomingMaintenance.handle()
    sent = CaptureEmailDriver.all()
    expect(sent.length).toBe(1)
  })

  test('a page showing two attached monitors still emails its subscriber once', async () => {
    const a = await makeMonitor('dup A')
    const b = await makeMonitor('dup B')
    await makePageWithSubscriber('notice-dup', 'dup@example.com', [a.id, b.id])
    await makeWindow({}, [a.id, b.id])

    await NotifyUpcomingMaintenance.handle()
    expect(CaptureEmailDriver.all().length).toBe(1)
  })

  test('a window beyond the 24h lead window is not announced yet', async () => {
    const monitor = await makeMonitor('far A')
    await makePageWithSubscriber('notice-far', 'far@example.com', [monitor.id])
    const win = await makeWindow({ starts_at: iso(3 * 24 * HOUR), ends_at: iso(3 * 24 * HOUR + 30 * 60_000) }, [monitor.id])

    await NotifyUpcomingMaintenance.handle()
    expect(CaptureEmailDriver.all().length).toBe(0)
    expect((await MaintenanceWindow.find(win.id))!.subscribers_notified_for).toBeFalsy()
  })

  test('subscribers of an unrelated page (monitor not attached) are spared', async () => {
    const covered = await makeMonitor('rel covered')
    const other = await makeMonitor('rel other')
    await makePageWithSubscriber('notice-rel-covered', 'rel-covered@example.com', [covered.id])
    await makePageWithSubscriber('notice-rel-other', 'rel-other@example.com', [other.id])
    await makeWindow({}, [covered.id])

    await NotifyUpcomingMaintenance.handle()
    const recipients = CaptureEmailDriver.all().map(m => m.to)
    expect(recipients).toEqual(['rel-covered@example.com'])
  })

  test('a cancelled window is never announced', async () => {
    const monitor = await makeMonitor('cancel A')
    await makePageWithSubscriber('notice-cancel', 'cancel@example.com', [monitor.id])
    await makeWindow({ status: 'cancelled' }, [monitor.id])

    await NotifyUpcomingMaintenance.handle()
    expect(CaptureEmailDriver.all().length).toBe(0)
  })

  test('a recurring window announces the next occurrence', async () => {
    const monitor = await makeMonitor('recurring A')
    await makePageWithSubscriber('notice-recurring', 'recurring@example.com', [monitor.id])
    // Fires every hour; the next slot is well within the 24h lead window.
    await makeWindow({ recurrence_cron: '0 * * * *', starts_at: iso(-HOUR), ends_at: iso(-HOUR + 15 * 60_000) }, [monitor.id])

    await NotifyUpcomingMaintenance.handle()
    expect(CaptureEmailDriver.all().length).toBe(1)
  })
})
