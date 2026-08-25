import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { db } from '@stacksjs/database'
import HeartbeatMonitor from '../../Models/HeartbeatMonitor'
import Monitor from '../../Models/Monitor'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * Delete a monitor from the dashboard form, with the rows that only exist
 * because of it. Without this sweep a deleted monitor leaves orphaned
 * check history (the largest table in the app), an open incident that no
 * job can ever resolve, and — for a heartbeat monitor — a live ping token
 * whose CheckOverdueHeartbeats sweep would keep alerting on a monitor the
 * operator believes is gone.
 */
const CHILD_TABLES = [
  'check_results',
  'assertions',
  'incidents',
  'ssl_certificates',
  'dns_snapshots',
  'domain_registrations',
  'lighthouse_reports',
  'port_scan_results',
  'ai_checks',
  'crawls',
  'monitor_notification_channels',
  'monitor_tag_assignments',
  'status_page_monitors',
  'status_report_monitors',
  'maintenance_window_monitors',
]

export default new Action({
  name: 'DashboardDeleteMonitorAction',
  description: 'Delete a monitor and its dependent rows from the dashboard',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const monitorId = Number(request.get('monitorId'))
    if (!Number.isInteger(monitorId) || monitorId <= 0)
      return response.json({ error: 'A monitor id is required' }, { status: 422 })

    const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
    if (!monitor)
      return response.forbidden('You do not have access to this monitor')

    // Grandchildren first: incident_updates hang off incidents and
    // crawled_pages off crawls (neither carries a monitor_id of its own),
    // so the monitor_id sweep below would leave them orphaned.
    const incidentIds = (await db.selectFrom('incidents').where('monitor_id', '=', monitorId).select(['id']).execute())
      .map((row: any) => Number(row.id))
    if (incidentIds.length > 0)
      await db.deleteFrom('incident_updates').where('incident_id', 'in', incidentIds).execute()

    try {
      const crawlIds = (await db.selectFrom('crawls').where('monitor_id', '=', monitorId).select(['id']).execute())
        .map((row: any) => Number(row.id))
      if (crawlIds.length > 0)
        await db.deleteFrom('crawled_pages').where('crawl_id', 'in', crawlIds).execute()
    }
    catch {
      // crawl tables absent on this install
    }

    for (const heartbeat of await HeartbeatMonitor.where('monitor_id', monitorId).get())
      await heartbeat.delete()

    for (const table of CHILD_TABLES) {
      // Best-effort per table: a self-hosted install that has never run a
      // given check type may not have its table yet, and one missing table
      // must not strand the monitor half-deleted.
      try {
        await db.deleteFrom(table as any).where('monitor_id', '=', monitorId).execute()
      }
      catch {
        // table absent on this install
      }
    }

    await monitor.delete()

    return new Response(null, { status: 302, headers: { Location: '/dashboard/monitors?deleted=1' } })
  },
})
