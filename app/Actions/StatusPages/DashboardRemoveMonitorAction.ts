import { Action } from '@stacksjs/actions'
import StatusPageMonitor from '../../Models/StatusPageMonitor'

/**
 * `POST /dashboard/status-pages/{id}/monitors/remove` — detaches a
 * monitor from a status page (stacksjs/status#1 Phase 8). Removes the
 * pivot row only; the Monitor itself is untouched.
 */
export default new Action({
  name: 'DashboardRemoveMonitorAction',
  description: 'Detach a monitor from a status page from a dashboard form',

  async handle(request) {
    const statusPageId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))

    if (statusPageId && monitorId) {
      const pivot = await StatusPageMonitor.where('status_page_id', statusPageId).where('monitor_id', monitorId).first()
      if (pivot) await pivot.delete()
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-pages/${statusPageId}` } })
  },
})
