import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { awaitConfig, config } from '@stacksjs/config'
import { CaptureEmailDriver } from '@stacksjs/email/drivers/capture.ts'
import { emitter } from '@stacksjs/events'
import { db } from '@stacksjs/database'
import { featureTest } from '@stacksjs/testing'
import SendStatusReportUpdateNotification from '../../app/Actions/Notifications/SendStatusReportUpdateNotification'
import Monitor from '../../app/Models/Monitor'
import StatusPage from '../../app/Models/StatusPage'
import StatusPageMonitor from '../../app/Models/StatusPageMonitor'
import StatusPageSubscriber from '../../app/Models/StatusPageSubscriber'
import StatusReport from '../../app/Models/StatusReport'
import StatusReportUpdate from '../../app/Models/StatusReportUpdate'
import User from '../../app/Models/User'

// See monitor-crud.test.ts's TEAM_ID comment.
const TEAM_ID = 90009
const OTHER_TEAM_ID = 90109
const OWNER_EMAIL = 'sr-owner-90009@example.com'
const OTHER_EMAIL = 'sr-other-90009@example.com'
const PASSWORD = 'a-real-password-1'

describe('Status report authoring (stacksjs/status#1 Phase 12 follow-up)', () => {
  let ownerId: number
  let otherId: number
  let ownerToken: string
  let otherToken: string
  let monitorId: number
  let statusPage: { id: number, slug: string }
  const reportIds: number[] = []

  // Wire just the observe listener to the real notification action so a
  // dashboard update-post exercises the full path (observe -> action ->
  // job -> subscriber email). The wildcard app/Events.ts wiring only runs
  // in the API server process, not under bun test.
  const observeListener = (e: unknown) => { void SendStatusReportUpdateNotification.handle(e as never) }

  beforeAll(async () => {
    await awaitConfig()
    ;(config.email as { default: string }).default = 'capture'
    emitter.on('statusreportupdate:created', observeListener as never)

    const owner = await User.create({ name: 'SR Owner', email: OWNER_EMAIL, password: PASSWORD })
    const other = await User.create({ name: 'SR Other', email: OTHER_EMAIL, password: PASSWORD })
    ownerId = owner.id
    otherId = other.id
    ownerToken = String((await (await import('@stacksjs/auth')).Auth.loginUsingId(ownerId, { withRefreshToken: false }))!.token)
    otherToken = String((await (await import('@stacksjs/auth')).Auth.loginUsingId(otherId, { withRefreshToken: false }))!.token)

    for (const [team, user, email] of [[TEAM_ID, ownerId, OWNER_EMAIL], [OTHER_TEAM_ID, otherId, OTHER_EMAIL]] as const) {
      await db.insertInto('teams').values({ id: team, name: `SR team ${team}` }).execute()
      await db.insertInto('team_members').values({ team_id: team, user_id: user, role: 'owner', status: 'active', invited_email: email }).execute()
    }

    const monitor = await Monitor.create({ team_id: TEAM_ID, name: 'SR monitor', url: 'https://example.com', type: 'uptime', status: 'up' })
    monitorId = monitor.id

    const page = await StatusPage.create({ team_id: TEAM_ID, title: 'SR status page', slug: 'sr-status-90009', is_public: true })
    statusPage = { id: page.id, slug: page.slug }
    await StatusPageMonitor.create({ status_page_id: page.id, monitor_id: monitorId, display_name: 'SR', display_order: 0 })
    await StatusPageSubscriber.create({ status_page_id: page.id, email: 'watcher-90009@example.com', unsubscribe_token: 'tok90009', confirmed_at: new Date().toISOString() })
  })

  afterEach(() => {
    CaptureEmailDriver.clear()
  })

  afterAll(async () => {
    emitter.off('statusreportupdate:created', observeListener as never)
    for (const id of reportIds) {
      await db.deleteFrom('status_report_monitors').where('status_report_id', '=', id).execute()
      await db.deleteFrom('status_report_updates').where('status_report_id', '=', id).execute()
      await db.deleteFrom('status_reports').where('id', '=', id).execute()
    }
    await db.deleteFrom('status_page_subscribers').where('status_page_id', '=', statusPage.id).execute()
    await db.deleteFrom('status_page_monitors').where('status_page_id', '=', statusPage.id).execute()
    await db.deleteFrom('status_pages').where('id', '=', statusPage.id).execute()
    await db.deleteFrom('monitors').where('id', '=', monitorId).execute()
    for (const [team, user] of [[TEAM_ID, ownerId], [OTHER_TEAM_ID, otherId]] as const) {
      await db.deleteFrom('oauth_access_tokens').where('user_id', '=', user).execute()
      await db.deleteFrom('team_members').where('team_id', '=', team).execute()
      await db.deleteFrom('teams').where('id', '=', team).execute()
      await db.deleteFrom('users').where('id', '=', user).execute()
    }
  })

  const asOwner = () => featureTest().withHeaders({ 'x-csrf-token': 'c9', 'cookie': `X-CSRF-Token=c9; auth-token=${ownerToken}` })
  const asOther = () => featureTest().withHeaders({ 'x-csrf-token': 'c9', 'cookie': `X-CSRF-Token=c9; auth-token=${otherToken}` })

  test('create requires authentication', async () => {
    const res = await featureTest().withHeaders({ 'x-csrf-token': 'c9', 'cookie': 'X-CSRF-Token=c9' }).post('/api/status-report-forms/create', { title: 'x', status: 'investigating' })
    expect(res.status).toBe(401)
  })

  test('full authoring flow: create, attach monitor, post update (notifies), status bumps', async () => {
    // Create.
    const create = await asOwner().post('/api/status-report-forms/create', { title: 'Weekend migration', body: 'Planned work', status: 'investigating' })
    expect(create.status).toBe(302)
    const report = await StatusReport.where('team_id', '=', TEAM_ID).where('title', '=', 'Weekend migration').first()
    expect(report).toBeTruthy()
    reportIds.push(report!.id)
    expect(create.headers.get('Location')).toBe(`/dashboard/status-reports/${report!.id}`)

    // Attach the monitor (the pivot that gives the report an audience).
    const attach = await asOwner().post(`/api/status-report-forms/${report!.id}/monitors/add`, { monitor_id: monitorId })
    expect(attach.status).toBe(302)
    const pivots = await db.selectFrom('status_report_monitors').where('status_report_id', '=', report!.id).execute()
    expect(pivots.length).toBe(1)

    // Post an update -> creates the update row, bumps the parent, and
    // emails the covered status page's subscriber.
    const update = await asOwner().post(`/api/status-report-forms/${report!.id}/updates`, { message: 'Migration underway, brief read-only window.', status: 'monitoring' })
    expect(update.status).toBe(302)
    expect(update.headers.get('Location')).toBe(`/dashboard/status-reports/${report!.id}?posted=1`)

    const updates = await StatusReportUpdate.where('status_report_id', '=', report!.id).get()
    expect(updates.length).toBe(1)
    expect(updates[0]!.message).toContain('Migration underway')

    const bumped = await StatusReport.find(report!.id)
    expect(bumped!.status).toBe('monitoring')

    const sent = CaptureEmailDriver.all()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe('watcher-90009@example.com')
    expect(String(sent[0]!.text)).toContain('Migration underway')
  })

  test('resolving stamps resolved_at and drops the report off the public page filter', async () => {
    const create = await asOwner().post('/api/status-report-forms/create', { title: 'To resolve', status: 'investigating' })
    const report = await StatusReport.where('team_id', '=', TEAM_ID).where('title', '=', 'To resolve').first()
    reportIds.push(report!.id)
    await asOwner().post(`/api/status-report-forms/${report!.id}/monitors/add`, { monitor_id: monitorId })

    await asOwner().post(`/api/status-report-forms/${report!.id}/updates`, { message: 'All clear.', status: 'resolved' })
    const resolved = await StatusReport.find(report!.id)
    expect(resolved!.status).toBe('resolved')
    expect(resolved!.resolved_at).toBeTruthy()
    void create
  })

  test('another team cannot attach a monitor to, or post to, this team report', async () => {
    const create = await asOwner().post('/api/status-report-forms/create', { title: 'Owned', status: 'investigating' })
    const report = await StatusReport.where('team_id', '=', TEAM_ID).where('title', '=', 'Owned').first()
    reportIds.push(report!.id)
    void create

    const attach = await asOther().post(`/api/status-report-forms/${report!.id}/monitors/add`, { monitor_id: monitorId })
    expect(attach.status).toBe(403)
    expect((await db.selectFrom('status_report_monitors').where('status_report_id', '=', report!.id).execute()).length).toBe(0)

    const post = await asOther().post(`/api/status-report-forms/${report!.id}/updates`, { message: 'nope', status: 'monitoring' })
    expect(post.status).toBe(403)
    expect((await StatusReportUpdate.where('status_report_id', '=', report!.id).get()).length).toBe(0)
  })

  test('delete removes the report, its pivots, and its updates', async () => {
    const create = await asOwner().post('/api/status-report-forms/create', { title: 'Temp', status: 'investigating' })
    const report = await StatusReport.where('team_id', '=', TEAM_ID).where('title', '=', 'Temp').first()
    await asOwner().post(`/api/status-report-forms/${report!.id}/monitors/add`, { monitor_id: monitorId })
    await asOwner().post(`/api/status-report-forms/${report!.id}/updates`, { message: 'hi', status: 'investigating' })
    void create

    const del = await asOwner().post(`/api/status-report-forms/${report!.id}/delete`, {})
    expect(del.status).toBe(302)
    expect(await StatusReport.find(report!.id)).toBeFalsy()
    expect((await db.selectFrom('status_report_monitors').where('status_report_id', '=', report!.id).execute()).length).toBe(0)
    expect((await StatusReportUpdate.where('status_report_id', '=', report!.id).get()).length).toBe(0)
  })
})
