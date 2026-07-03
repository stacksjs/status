import { Action } from '@stacksjs/actions'
import StatusPageMonitor from '../../Models/StatusPageMonitor'

/**
 * `POST /dashboard/status-pages/{id}/monitors/add` — attaches a monitor
 * to a status page from a dashboard form (stacksjs/status#1 Phase 8).
 * No-ops if already attached rather than creating a duplicate row.
 */
export default new Action({
  name: 'DashboardAssignMonitorAction',
  description: 'Attach a monitor to a status page from a dashboard form',

  async handle(request) {
    const statusPageId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))
    const displayName = request.get('display_name')

    if (statusPageId && monitorId) {
      const existing = await StatusPageMonitor.where('status_page_id', statusPageId).where('monitor_id', monitorId).first()
      if (!existing) {
        await StatusPageMonitor.create({
          status_page_id: statusPageId,
          monitor_id: monitorId,
          display_name: displayName || undefined,
          display_order: 0,
        })
      }
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${statusPageId}` } })
  },
})
